// End-to-end test: drives the live n8n webhooks the way Twilio and Vapi would.
//
// Run (from n8n/ai-voice-agent/tests, n8n installed locally, all values are fakes):
//   node mock_apis.js &                                         # mock Vapi + Twilio on :4010
//   node prepare_test_workflow.js ../n8n_workflow_template.json wf_test.json
//   n8n import:credentials --input=test_credentials.json
//   n8n import:workflow --input=wf_test.json && n8n publish:workflow --id=voiceAgentTest01
//   N8N_BLOCK_ENV_ACCESS_IN_NODE=false COMPANY_NAME="Test Co" \
//   HUMAN_SUPPORT_NUMBER=+14165550111 HUMAN_SALES_NUMBER=+14165550122 \
//   VAPI_PHONE_NUMBER_ID=pn-test-123 VAPI_TOOL_SECRET=s3cret n8n start &
//   VAPI_TOOL_SECRET=s3cret node e2e.js                          # omit the secret in both to test the no-secret mode
const { execFileSync } = require('child_process');
const N8N = process.env.N8N_BASE || 'http://127.0.0.1:5678';
const MOCK = 'http://127.0.0.1:4010';
const CALL_SID = 'CA' + 'a'.repeat(32);
const ACCOUNT_SID = 'AC' + 'b'.repeat(32);
const SECRET = process.env.VAPI_TOOL_SECRET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { failures++; if (extra !== undefined) console.log('      ->', typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 1500)); }
};
const wellFormedXml = (s) => {
  try { execFileSync('python3', ['-I', '-c', 'import sys,xml.dom.minidom;xml.dom.minidom.parseString(sys.stdin.buffer.read())'], { input: s }); return true; } catch { return false; }
};
const twilioPost = (path, fields) => fetch(`${N8N}/webhook/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'test' },
  body: new URLSearchParams({ AccountSid: ACCOUNT_SID, CallSid: CALL_SID, From: '+14165550100', To: '+19055550199', Direction: 'inbound', CallStatus: 'in-progress', ...fields }),
});
const mode = (m) => fetch(`${MOCK}/__mode/${m}`);
const mockLog = async () => (await fetch(`${MOCK}/__log`)).json();

// Allowed keys, taken from @vapi-ai/server-sdk type definitions (Vapi rejects unknown keys).
const allowed = {
  root: ['phoneNumberId', 'phoneCallProviderBypassEnabled', 'customer', 'assistant'],
  assistant: ['name', 'firstMessage', 'firstMessageMode', 'model', 'voice', 'transcriber', 'stopSpeakingPlan', 'maxDurationSeconds', 'metadata'],
  model: ['provider', 'model', 'temperature', 'messages', 'tools'],
  tool: ['type', 'async', 'messages', 'function', 'server'],
  fn: ['name', 'description', 'strict', 'parameters'],
  server: ['url', 'timeoutSeconds', 'headers'],
};
const onlyKeys = (obj, keys) => Object.keys(obj || {}).filter((k) => !keys.includes(k));

async function vapiDigit(digit, dept, expectedVoice, expectedNumber) {
  await mode('ok');
  const r = await twilioPost('twilio-dtmf', { Digits: digit });
  const text = await r.text();
  check(r.status === 200 && /text\/xml/.test(r.headers.get('content-type')), `[digit ${digit}] 200 text/xml`, `${r.status} ${r.headers.get('content-type')} ${text}`);
  check(text.includes('<Connect><Stream url="wss://phone-call-websocket.mock.vapi.ai'), `[digit ${digit}] returns Vapi stream TwiML to Twilio`, text);
  const log = await mockLog();
  const call = log.find((e) => e.url === '/call');
  check(!!call, `[digit ${digit}] Vapi POST /call was made`, log);
  if (!call) return;
  check(call.headers.authorization === 'Bearer test-vapi-key', `[digit ${digit}] Vapi auth header from credential`, call.headers.authorization);
  let b; try { b = JSON.parse(call.body); } catch (e) { check(false, 'vapi body is JSON', call.body); return; }
  const a = b.assistant, tool = a.model.tools[0];
  check(b.phoneCallProviderBypassEnabled === true && b.phoneNumberId === 'pn-test-123', `[digit ${digit}] bypass + phoneNumberId`, b);
  check(b.customer.number === '+14165550100', `[digit ${digit}] customer number = caller`, b.customer);
  check(onlyKeys(b, allowed.root).length + onlyKeys(a, allowed.assistant).length + onlyKeys(a.model, allowed.model).length + onlyKeys(tool, allowed.tool).length + onlyKeys(tool.function, allowed.fn).length + onlyKeys(tool.server, allowed.server).length === 0, `[digit ${digit}] payload only uses whitelisted Vapi fields`);
  check(a.voice.voiceId === expectedVoice && a.voice.provider === '11labs', `[digit ${digit}] voice ${expectedVoice}`, a.voice);
  check(a.model.model === 'gpt-4o-mini' && a.model.messages[0].role === 'system' && a.model.messages[0].content.includes('Test Co'), `[digit ${digit}] gpt-4o-mini + system prompt w/ company`, a.model.messages[0].content.slice(0, 120));
  check(a.firstMessage.includes(dept) && a.firstMessage.includes('Test Co'), `[digit ${digit}] greeting mentions ${dept}`, a.firstMessage);
  check(tool.function.name === 'transfer_to_human' && tool.async === true && tool.function.parameters.required.join() === 'reason,department', `[digit ${digit}] transfer_to_human tool schema`, tool.function);
  check(tool.messages[0].type === 'request-start' && tool.messages[0].blocking === true, `[digit ${digit}] blocking hold message`, tool.messages);
  const u = new URL(tool.server.url);
  check(u.pathname === '/webhook/vapi-escalation' && u.searchParams.get('callSid') === CALL_SID && u.searchParams.get('accountSid') === ACCOUNT_SID && u.searchParams.get('department') === dept, `[digit ${digit}] tool server URL carries callSid/accountSid/department`, tool.server.url);
  check(SECRET ? tool.server.headers?.['x-vapi-secret'] === SECRET : !tool.server.headers, `[digit ${digit}] secret header ${SECRET ? 'present' : 'omitted'}`, tool.server);
  check(a.metadata.twilioCallSid === CALL_SID && a.metadata.department === dept, `[digit ${digit}] metadata`, a.metadata);
  return { url: tool.server.url };
}

(async () => {
  // 1. Inbound call
  let r = await twilioPost('twilio-inbound-call', {});
  let t = await r.text();
  check(r.status === 200 && /text\/xml/.test(r.headers.get('content-type')), 'inbound: 200 text/xml', `${r.status} ${t}`);
  check(t.includes('<Gather input="dtmf" numDigits="1"') && t.includes('action="twilio-dtmf"') && t.includes('Press 1 for Support, or press 2 for Sales'), 'inbound: Gather TwiML', t);
  check(wellFormedXml(t), 'inbound: well-formed XML');

  // 2-3. Department routing -> Vapi
  const support = await vapiDigit('1', 'support', 'sarah');
  await vapiDigit('2', 'sales', 'mark');

  // 4. Invalid + empty digit
  for (const d of ['9', '']) {
    await mode('ok');
    r = await twilioPost('twilio-dtmf', { Digits: d });
    t = await r.text();
    check(r.status === 200 && t.includes('not a valid option') && t.includes('<Redirect method="POST">twilio-inbound-call</Redirect>') && wellFormedXml(t), `invalid digit "${d}": replays menu`, t);
    check((await mockLog()).length === 0, `invalid digit "${d}": no Vapi call`);
  }

  // 5. Vapi failure -> direct human dial
  for (const [m, digit, num] of [['error', '1', '+14165550111'], ['notwiml', '2', '+14165550122']]) {
    await mode(m);
    r = await twilioPost('twilio-dtmf', { Digits: digit });
    t = await r.text();
    check(r.status === 200 && t.includes(`<Dial timeout="25">${num}</Dial>`) && wellFormedXml(t), `vapi ${m}: falls back to dialing ${num}`, `${r.status} ${t}`);
  }

  // 6. Escalation tool call (arguments as JSON string, per SDK types)
  await mode('ok');
  const escUrl = new URL(support.url);
  const esc = (body, headers = {}, query = escUrl.search) => fetch(`${N8N}/webhook/vapi-escalation${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(SECRET ? { 'x-vapi-secret': SECRET } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const toolMsg = (args, extra = {}) => ({ message: { type: 'tool-calls', toolCallList: [{ id: 'call_tool_1', type: 'function', function: { name: 'transfer_to_human', arguments: args } }], call: { id: 'call_mock_123' }, assistant: { metadata: { department: 'support', twilioCallSid: CALL_SID } }, ...extra } });

  let started = Date.now();
  r = await esc(toolMsg(JSON.stringify({ reason: 'Billing dispute & refund <urgent>', department: 'support' })));
  let j = await r.json();
  check(r.status === 200 && j.results?.[0]?.toolCallId === 'call_tool_1' && /support/.test(j.results[0].result), 'escalation: acknowledges Vapi with results[]', j);
  check(Date.now() - started < 1500, `escalation: Vapi ack is immediate (${Date.now() - started}ms)`);
  let twilio;
  for (let i = 0; i < 40 && !twilio; i++) { await sleep(250); twilio = (await mockLog()).find((e) => e.url.includes('/Calls/')); }
  check(!!twilio, 'escalation: Twilio call-update request sent');
  if (twilio) {
    const elapsed = Date.now() - started;
    check(elapsed >= 1900, `escalation: waited for hold message before redirect (${elapsed}ms)`);
    check(twilio.url === `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${CALL_SID}.json`, 'escalation: correct Twilio URL', twilio.url);
    check(twilio.headers.authorization === 'Basic ' + Buffer.from(`${ACCOUNT_SID}:test-twilio-token`).toString('base64'), 'escalation: Twilio basic auth from credential', twilio.headers.authorization);
    check(/application\/x-www-form-urlencoded/.test(twilio.headers['content-type']), 'escalation: form-encoded body', twilio.headers['content-type']);
    const twiml = new URLSearchParams(twilio.body).get('Twiml') || '';
    check(wellFormedXml(twiml), 'escalation: transfer TwiML is well-formed XML', twiml);
    check(twiml.includes('>+14165550111</Number></Dial>'), 'escalation: dials support human', twiml);
    const whisper = twiml.match(/<Number url="([^"]+)"/)?.[1].replace(/&amp;/g, '&');
    check(!!whisper && new URL(whisper).pathname === '/webhook/transfer-whisper', 'escalation: whisper URL attached', twiml);
    if (whisper) {
      const wu = new URL(whisper);
      r = await fetch(`${N8N}${wu.pathname}${wu.search}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'CallSid=CA' + 'c'.repeat(32) });
      t = await r.text();
      check(r.status === 200 && wellFormedXml(t) && t.includes('Incoming support transfer') && t.includes('Billing dispute &amp; refund &lt;urgent&gt;'), 'whisper: briefs human with escaped reason', t);
    }
  }

  // 7. Cross-department transfer, arguments as object, no query string (metadata fallback)
  await mode('ok');
  r = await esc(toolMsg({ reason: 'Wants a quote for 20 seats', department: 'sales' }), {}, `?accountSid=${ACCOUNT_SID}`);
  j = await r.json();
  check(r.status === 200 && /sales/.test(j.results?.[0]?.result), 'escalation (object args, metadata callSid): ack sales', j);
  twilio = undefined;
  for (let i = 0; i < 40 && !twilio; i++) { await sleep(250); twilio = (await mockLog()).find((e) => e.url.includes('/Calls/')); }
  check(twilio && new URLSearchParams(twilio.body).get('Twiml').includes('>+14165550122</Number>'), 'escalation: support->sales override dials sales human', twilio && twilio.body);

  // 8. Rejections
  if (SECRET) {
    await mode('ok');
    r = await esc(toolMsg('{"reason":"x","department":"support"}'), { 'x-vapi-secret': 'wrong' });
    j = await r.json();
    check(r.status === 401 && j.results?.[0]?.error === 'Unauthorized tool call.', 'escalation: wrong secret -> 401', { status: r.status, j });
  }
  await mode('ok');
  r = await esc({ message: { type: 'tool-calls', toolCallList: [{ id: 'call_tool_2', type: 'function', function: { name: 'transfer_to_human', arguments: '{}' } }] } }, {}, '');
  j = await r.json();
  check(r.status === 200 && /Call SID/.test(j.results?.[0]?.error), 'escalation: missing call SID -> tool error (200)', j);
  await sleep(2500);
  check(!(await mockLog()).some((e) => e.url.includes('/Calls/')), 'rejections: no Twilio redirect issued');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
