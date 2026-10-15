// Mock Vapi + Twilio REST APIs for end-to-end testing of the n8n workflow.
const http = require('http');
const log = [];
let vapiMode = 'ok'; // ok | error | notwiml

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const entry = { method: req.method, url: req.url, headers: req.headers, body };
    if (req.url === '/__log') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(log)); }
    if (req.url.startsWith('/__mode/')) { vapiMode = req.url.split('/')[2]; log.length = 0; return res.end('ok'); }
    log.push(entry);
    if (req.url === '/call' && req.method === 'POST') {
      if (vapiMode === 'error') { res.statusCode = 400; return res.end(JSON.stringify({ message: ['bad request'], error: 'Bad Request', statusCode: 400 })); }
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      const out = { id: 'call_mock_123', status: 'queued', type: 'inboundPhoneCall' };
      if (vapiMode !== 'notwiml') out.phoneCallProviderDetails = { twiml: '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://phone-call-websocket.mock.vapi.ai/call_mock_123/transport"/></Connect></Response>' };
      return res.end(JSON.stringify(out));
    }
    if (/^\/2010-04-01\/Accounts\/AC\w+\/Calls\/CA\w+\.json$/.test(req.url) && req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ sid: req.url.match(/Calls\/(CA\w+)/)[1], status: 'in-progress' }));
    }
    res.statusCode = 404; res.end('not found');
  });
}).listen(4010, () => console.log('mock listening on 4010'));
