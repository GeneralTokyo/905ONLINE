// End-to-end test for n8n_workflow_vapi_only.json: posts the events Vapi sends to a
// phone number's Server URL and checks n8n's answers.
//
// Run (from n8n/ai-voice-agent/tests, n8n installed locally):
//   node prepare_vapi_only_test.js full ../n8n_workflow_vapi_only.json wf_vapi.json
//   n8n import:workflow --input=wf_vapi.json && n8n publish:workflow --id=vapiOnlyTest001
//   n8n start &
//   CONFIG=full node e2e_vapi_only.js
// Repeat with "minimal" in both commands to test the no-numbers / no-secret settings.
const N8N = process.env.N8N_BASE || 'http://127.0.0.1:5678';
const CONFIG = process.env.CONFIG || 'full';
const SECRET = 's3cret-key';
let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { failures++; if (extra !== undefined) console.log('      ->', typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 1500)); }
};
const post = (body, { query = CONFIG === 'full' ? `?key=${SECRET}` : '', headers = {} } = {}) =>
  fetch(`${N8N}/webhook/vapi-server${query}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const call = { id: 'call_abc', type: 'inboundPhoneCall', customer: { number: '+14165550100' }, phoneNumberId: 'pn_1' };

// Allowed keys, from @vapi-ai/server-sdk type definitions (Vapi rejects unknown keys).
const allowed = {
  response: ['assistant'],
  assistant: ['name', 'firstMessage', 'firstMessageMode', 'keypadInputPlan', 'model', 'voice', 'transcriber', 'stopSpeakingPlan', 'maxDurationSeconds', 'serverMessages', 'metadata'],
  model: ['provider', 'model', 'temperature', 'messages', 'tools'],
  tool: ['type', 'destinations'],
  destination: ['type', 'number', 'description', 'message', 'transferPlan'],
  transferPlan: ['mode', 'message'],
  keypad: ['enabled', 'timeoutSeconds'],
};
const extraKeys = (obj, keys) => Object.keys(obj || {}).filter((k) => !keys.includes(k));

(async () => {
  // n8n answers /healthz before workflows finish activating; wait for the webhook.
  for (let i = 0; i < 30; i++) {
    const probe = await fetch(`${N8N}/webhook/vapi-server`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
    if (probe && probe.status !== 404) break;
    await new Promise((res) => setTimeout(res, 1000));
  }

  // 1. Phone rings -> assistant-request
  let t0 = Date.now();
  let r = await post({ message: { type: 'assistant-request', call, customer: call.customer, timestamp: Date.now() } });
  const ms = Date.now() - t0;
  let j = await r.json().catch(() => ({}));
  check(r.status === 200 && /application\/json/.test(r.headers.get('content-type')), `assistant-request: 200 JSON (${ms}ms, Vapi allows 7.5s)`, { status: r.status, j });
  const a = j.assistant || {};
  a.firstMessage = a.firstMessage || '';
  const bad = [
    ...extraKeys(j, allowed.response), ...extraKeys(a, allowed.assistant), ...extraKeys(a.model, allowed.model),
    ...extraKeys(a.keypadInputPlan, allowed.keypad),
    ...(a.model?.tools || []).flatMap((t) => [...extraKeys(t, allowed.tool), ...(t.destinations || []).flatMap((d) => [...extraKeys(d, allowed.destination), ...extraKeys(d.transferPlan, allowed.transferPlan)])]),
  ];
  check(bad.length === 0, 'assistant-request: only whitelisted Vapi fields', bad);
  const prompt = a.model?.messages?.[0]?.content || '';
  check(a.model?.model === 'gpt-4o-mini' && a.model.messages[0].role === 'system', 'assistant: gpt-4o-mini + system prompt');
  check(!/\{company\}|\{agent\}/.test(prompt + a.firstMessage), 'assistant: all {company}/{agent} placeholders filled', a.firstMessage);
  check(a.keypadInputPlan?.enabled === true, 'assistant: keypad (DTMF) input enabled');
  check(/press 1/i.test(a.firstMessage) && /press 2/i.test(a.firstMessage), 'assistant: greeting offers press 1 / press 2', a.firstMessage);
  check(a.serverMessages?.join() === 'transfer-update,end-of-call-report', 'assistant: subscribes to transfer + end-of-call events', a.serverMessages);
  check(a.voice?.provider === '11labs' && a.transcriber?.provider === 'deepgram', 'assistant: voice + transcriber set');

  if (CONFIG === 'full') {
    check(a.firstMessage.includes('Test Co') && prompt.includes('Test Co') && prompt.includes('You are Max'), 'full: company + agent name applied', a.firstMessage);
    const tool = a.model.tools?.[0];
    check(tool?.type === 'transferCall' && tool.destinations?.length === 2, 'full: transferCall tool with 2 destinations', tool);
    const [sup, sal] = tool?.destinations || [];
    check(sup?.number === '+14165550111' && /support/i.test(sup.description), 'full: support destination (number cleaned to E.164)', sup);
    check(sal?.number === '+14165550122' && /sales/i.test(sal.description), 'full: sales destination', sal);
    check(sup?.transferPlan?.mode === 'warm-transfer-say-message' && /support call/.test(sup.transferPlan.message), 'full: warm transfer message briefs the human', sup?.transferPlan);
    check(/transferCall tool/.test(prompt), 'full: prompt tells the AI how to transfer');

    // Secret handling
    r = await post({ message: { type: 'assistant-request', call } }, { query: '' });
    check(r.status === 401, 'full: missing secret -> 401', r.status);
    r = await post({ message: { type: 'assistant-request', call } }, { query: '?key=wrong' });
    check(r.status === 401, 'full: wrong secret -> 401', r.status);
    r = await post({ message: { type: 'assistant-request', call } }, { query: '', headers: { 'x-vapi-secret': SECRET } });
    check(r.status === 200 && (await r.json()).assistant, 'full: secret via x-vapi-secret header also accepted');
  } else {
    check(!a.model.tools, 'minimal: no transfer numbers -> no transfer tool', a.model.tools);
    check(/Transfers are not available/.test(prompt), 'minimal: AI told to take a message instead');
    check(a.firstMessage.includes('Acme Co'), 'minimal: default company name', a.firstMessage);
  }

  // 2. Transfer + end-of-call + other events are acknowledged
  r = await post({ message: { type: 'transfer-update', call, destination: { type: 'number', number: '+14165550111' } } });
  check(r.status === 200 && (await r.json()).received === true, 'transfer-update: acknowledged');
  r = await post({ message: { type: 'end-of-call-report', call, endedReason: 'assistant-forwarded-call', cost: 0.12, analysis: { summary: 'Caller asked for billing help.' }, artifact: { transcript: 'AI: Hi\nUser: Hello', recordingUrl: 'https://example.com/r.wav' } } });
  check(r.status === 200 && (await r.json()).received === true, 'end-of-call-report: acknowledged');
  r = await post({ message: { type: 'status-update', status: 'in-progress', call } });
  check(r.status === 200 && (await r.json()).received === true, 'other event (status-update): acknowledged');
  r = await post({ hello: 'world' });
  check(r.status === 200, 'malformed body: acknowledged, no crash', r.status);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
