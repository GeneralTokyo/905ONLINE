// Builds a test copy: real API hosts -> local mock, credentials attached.
const fs = require('fs');
const [src, out] = process.argv.slice(2);
const wf = JSON.parse(fs.readFileSync(src, 'utf8'));
let s = JSON.stringify(wf)
  .replace('https://api.vapi.ai/call', 'http://127.0.0.1:4010/call')
  .replace('=https://api.twilio.com/2010-04-01', '=http://127.0.0.1:4010/2010-04-01');
const t = JSON.parse(s);
t.id = 'voiceAgentTest01';
for (const n of t.nodes) {
  if (n.name === 'Trigger Vapi Inbound Call') n.credentials = { httpHeaderAuth: { id: 'credVapi0000001', name: 'Vapi API Key' } };
  if (n.name === 'Execute Twilio Call Transfer') n.credentials = { twilioApi: { id: 'credTwilio00001', name: 'Twilio account' } };
}
fs.writeFileSync(out, JSON.stringify(t, null, 2));
