// Tests for the NextMsg MCP server and CLI against a local mock of the NextMsg API.
// Run from anywhere: node mcp/test.mcp.js  or  npm test (inside mcp/)
import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const INDEX = fileURLToPath(new URL('./index.js', import.meta.url));

// ---- Mock API: records requests; /p/<key> answers like the real ingress ----
const received = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.startsWith('/p/nextmsg_live_slow')) return; // never answers: exercises the timeout
    if (req.method === 'POST' && req.url.startsWith('/p/')) {
      received.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: '018f3a2c-mock', status: 'queued' }));
      return;
    }
    res.writeHead(404).end();
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${mock.address().port}`;
const env = (extra = {}) => ({ ...process.env, NEXTMSG_KEY: 'nextmsg_live_mockkey', NEXTMSG_API_BASE: API, ...extra });

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

/** Runs the CLI with the given args and stdin text; resolves { code, stdout, stderr }. */
function runCli(args, { stdin = '', extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [INDEX, ...args], { env: env(extraEnv), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
    p.stdin.end(stdin);
  });
}

/** Starts the MCP server and returns a request() helper plus a way to stop it. */
function startMcp(extraEnv = {}) {
  const p = spawn(process.execPath, [INDEX, '--mcp'], { env: env(extraEnv), stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  const lines = [];
  const waiters = [];
  p.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const msg = JSON.parse(line); // anything but JSON on stdout would throw here
      lines.push(msg);
      waiters.splice(0).forEach((w) => w());
    }
  });
  const nextFor = (id) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no response for id ${id}`)), 4000);
      const check = () => {
        const found = lines.find((m) => m.id === id);
        if (found) { clearTimeout(t); resolve(found); } else waiters.push(check);
      };
      check();
    });
  return {
    send: (obj) => p.stdin.write(JSON.stringify(obj) + '\n'),
    request: (id, method, params) => { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return nextFor(id); },
    lines,
    stop: () => p.kill()
  };
}

// ---------------- MCP server ----------------
const mcp = startMcp();

await test('initialize echoes a supported protocol version', async () => {
  const r = await mcp.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.equal(r.result.serverInfo.name, 'nextmsg');
});

await test('initialize falls back to the latest version for an unknown one', async () => {
  const r = await mcp.request(2, 'initialize', { protocolVersion: '1999-01-01' });
  assert.equal(r.result.protocolVersion, '2025-06-18');
});

await test('notifications get no response', async () => {
  const before = mcp.lines.length;
  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await mcp.request(3, 'ping');
  assert.equal(mcp.lines.length, before + 1); // only the ping reply
});

await test('tools/list: notify_human without a send_key argument', async () => {
  const r = await mcp.request(4, 'tools/list');
  const tool = r.result.tools.find((t) => t.name === 'notify_human');
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['channel', 'message']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  // Guidance that keeps agents from spamming the phone, leaking secrets or retrying in a loop
  assert.match(tool.description, /not progress updates/);
  assert.match(tool.description, /actively chatting/);
  assert.match(tool.description, /Never include secrets/);
  assert.match(tool.description, /instead of retrying/);
});

await test('tools/call sends message and channel', async () => {
  received.length = 0;
  const r = await mcp.request(5, 'tools/call', { name: 'notify_human', arguments: { message: 'Deploy **done**', channel: 'CI' } });
  assert.equal(r.result.isError, false);
  assert.deepEqual(received[0].body, { message: 'Deploy **done**', channel: 'ci' });
  assert.ok(received[0].url.startsWith('/p/nextmsg_live_mockkey'));
});

await test('tools/call ignores a send_key argument (key only from NEXTMSG_KEY)', async () => {
  received.length = 0;
  await mcp.request(6, 'tools/call', { name: 'notify_human', arguments: { message: 'x', send_key: 'nextmsg_live_attacker' } });
  assert.ok(received[0].url.startsWith('/p/nextmsg_live_mockkey'));
});

await test('missing message is an error and sends nothing (no "undefined")', async () => {
  received.length = 0;
  const r = await mcp.request(7, 'tools/call', { name: 'notify_human', arguments: {} });
  assert.equal(r.result.isError, true);
  assert.equal(received.length, 0);
});

await test('300 emoji count as 300 characters and are sent', async () => {
  received.length = 0;
  const r = await mcp.request(8, 'tools/call', { name: 'notify_human', arguments: { message: '👍'.repeat(300) } });
  assert.equal(r.result.isError, false);
  assert.equal(received.length, 1);
});

await test('641 characters are rejected before sending', async () => {
  received.length = 0;
  const r = await mcp.request(9, 'tools/call', { name: 'notify_human', arguments: { message: 'a'.repeat(641) } });
  assert.equal(r.result.isError, true);
  assert.equal(received.length, 0);
});

await test('unknown tool returns -32602, unknown method -32601', async () => {
  assert.equal((await mcp.request(10, 'tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  assert.equal((await mcp.request(11, 'resources/list')).error.code, -32601);
});
mcp.stop();

await test('a stalled API times out with a readable error', async () => {
  const slow = startMcp({ NEXTMSG_KEY: 'nextmsg_live_slow', NEXTMSG_TIMEOUT_MS: '300' });
  const r = await slow.request(1, 'tools/call', { name: 'notify_human', arguments: { message: 'x' } });
  slow.stop();
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /did not respond/);
});

await test('no NEXTMSG_KEY is a clear tool error', async () => {
  const nokey = startMcp({ NEXTMSG_KEY: '' });
  const r = await nokey.request(1, 'tools/call', { name: 'notify_human', arguments: { message: 'x' } });
  nokey.stop();
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /NEXTMSG_KEY/);
});

// ---------------- CLI ----------------
await test('CLI sends without a terminal, like a Claude Code hook (JSON on stdin)', async () => {
  received.length = 0;
  const r = await runCli(['Claude Code finished', '--channel=claude-code'], { stdin: '{"hook_event_name":"Stop"}' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(received[0].body, { message: 'Claude Code finished', channel: 'claude-code' });
});

await test('CLI: -- lets a message start with "-"', async () => {
  received.length = 0;
  const r = await runCli(['-c', 'ci', '--', '-1 tests failing']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(received[0].body.message, '-1 tests failing');
});

await test('CLI: unknown option and missing key fail with exit 1', async () => {
  assert.equal((await runCli(['--chanel', 'ci', 'x'])).code, 1);
  assert.equal((await runCli(['hello'], { extraEnv: { NEXTMSG_KEY: '' } })).code, 1);
});

mock.close();
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
