// Static checks: every connection points at a real node/output, every functional
// node is reachable from a webhook, and every responseNode webhook can reach a
// Respond to Webhook node on every path.
const wf = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const errors = [];
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const functional = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');

// Unique names / ids / webhook paths
const dup = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);
if (dup(wf.nodes.map((n) => n.name)).length) errors.push('duplicate names ' + dup(wf.nodes.map((n) => n.name)));
if (dup(wf.nodes.map((n) => n.id)).length) errors.push('duplicate ids');
const hooks = functional.filter((n) => n.type === 'n8n-nodes-base.webhook');
if (dup(hooks.map((n) => n.parameters.path)).length) errors.push('duplicate webhook paths');

const expectedOutputs = (n) => {
  if (n.type === 'n8n-nodes-base.switch') return n.parameters.rules.values.length + (n.parameters.options?.fallbackOutput === 'extra' ? 1 : 0);
  if (n.type === 'n8n-nodes-base.if') return 2;
  if (n.onError === 'continueErrorOutput') return 2;
  return 1;
};

const children = {};
for (const [src, conn] of Object.entries(wf.connections)) {
  if (!byName[src]) errors.push(`connection source missing: ${src}`);
  const outs = conn.main || [];
  if (byName[src] && outs.length > expectedOutputs(byName[src])) errors.push(`${src} has ${outs.length} outputs wired, node only has ${expectedOutputs(byName[src])}`);
  outs.forEach((targets, i) => {
    if (!targets || !targets.length) errors.push(`${src} output ${i} is empty`);
    for (const t of targets || []) {
      if (!byName[t.node]) errors.push(`connection target missing: ${src} -> ${t.node}`);
      (children[src] ||= []).push({ node: t.node, output: i });
    }
  });
}

// Every output of a branching node must be wired (no silently dropped branch)
for (const n of functional) {
  const want = expectedOutputs(n);
  const isTerminal = n.type === 'n8n-nodes-base.respondToWebhook' || n.name === 'Execute Twilio Call Transfer';
  if (isTerminal) continue;
  const got = (wf.connections[n.name]?.main || []).filter((t) => t && t.length).length;
  if (got !== want) errors.push(`${n.name}: ${got}/${want} outputs connected`);
}

// Reachability from triggers
const reach = new Set();
const walk = (name) => { if (reach.has(name)) return; reach.add(name); (children[name] || []).forEach((c) => walk(c.node)); };
hooks.forEach((h) => walk(h.name));
for (const n of functional) if (!reach.has(n.name)) errors.push(`unreachable node: ${n.name}`);

// Every path from a responseNode webhook must hit a Respond node before ending
const pathsOk = (name, seen = new Set()) => {
  const n = byName[name];
  if (n.type === 'n8n-nodes-base.respondToWebhook') return true;
  if (seen.has(name)) return true;
  seen.add(name);
  const kids = children[name] || [];
  if (!kids.length) return false;
  return kids.every((k) => pathsOk(k.node, new Set(seen)));
};
for (const h of hooks) {
  if (h.parameters.responseMode !== 'responseNode') errors.push(`${h.name} not in responseNode mode`);
  else if (!pathsOk(h.name)) errors.push(`${h.name}: some path ends without a Respond to Webhook node`);
}

// Expressions must not contain a premature "}}" (very common copy/paste bug)
for (const n of functional) {
  const scan = (v, path) => {
    if (typeof v === 'string' && v.startsWith('=')) {
      const opens = (v.match(/\{\{/g) || []).length;
      const closes = (v.match(/\}\}/g) || []).length;
      if (opens !== closes) errors.push(`${n.name} ${path}: ${opens} "{{" vs ${closes} "}}"`);
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, path + '.' + k);
  };
  scan(n.parameters, 'parameters');
}

// Nodes referenced by $('...') must exist
const raw = JSON.stringify(wf.nodes.map((n) => n.parameters));
for (const m of raw.matchAll(/\$\(\\?'([^'\\]+)\\?'\)/g)) if (!byName[m[1]]) errors.push(`expression references missing node ${m[1]}`);

console.log(`${functional.length} functional nodes, ${hooks.length} webhooks, ${Object.keys(wf.connections).length} connection sources`);
if (errors.length) { console.error('FAIL\n- ' + errors.join('\n- ')); process.exit(1); }
console.log('OK: all nodes connected and reachable; every webhook path ends in a response');
