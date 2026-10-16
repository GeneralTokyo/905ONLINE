// Builds a test copy of the Vapi-only workflow with the Settings node filled in.
// Usage: node prepare_vapi_only_test.js <full|minimal> <src.json> <out.json>
const fs = require('fs');
const [mode, src, out] = process.argv.slice(2);
const wf = JSON.parse(fs.readFileSync(src, 'utf8'));
wf.id = 'vapiOnlyTest001';
const values = mode === 'full'
  ? { companyName: 'Test Co', agentName: 'Max', supportNumber: '+1 (416) 555-0111', salesNumber: '+14165550122', transferMode: 'warm-transfer-say-message', serverSecret: 's3cret-key' }
  : { supportNumber: '', salesNumber: 'not-a-number', transferMode: 'bogus-mode', serverSecret: '' };
const settings = wf.nodes.find((n) => n.name === 'Settings');
for (const a of settings.parameters.assignments.assignments) if (a.name in values) a.value = values[a.name];
fs.writeFileSync(out, JSON.stringify(wf, null, 2));
