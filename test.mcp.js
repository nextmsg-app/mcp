// Tests for the NextMsg MCP server and CLI against a local mock of the NextMsg API.
// Run: npm test
import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INDEX = fileURLToPath(new URL('./index.js', import.meta.url));

// ---- Mock API: /v1/send with the key in the header, /v1/agent/claim with single-use codes ----
const sent = [];
const claims = [];
const validKeys = new Set(['nextmsg_live_mockkey']);
const liveCodes = new Set();
let keyCounter = 0;

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST' && req.url === '/v1/send') {
      const key = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (key === 'nextmsg_live_slow') return; // never answers: exercises the timeout
      if (!validKeys.has(key)) return json(401, { error: 'Invalid or revoked agent key' });
      sent.push({ key, body: JSON.parse(body) });
      return json(200, { success: true, id: '018f3a2c-mock', status: 'queued' });
    }
    if (req.method === 'POST' && req.url === '/v1/agent/claim') {
      const { code, name } = JSON.parse(body);
      claims.push({ code, name });
      if (!liveCodes.delete(code)) {
        return json(400, { error: 'The code is wrong, already used or expired.', code: 'invalid_code' });
      }
      const key = `nextmsg_agent_${String(++keyCounter).padStart(48, '0')}`;
      validKeys.add(key);
      return json(200, { send_key: key, key_prefix: key.slice(0, 26), name });
    }
    if (req.url.startsWith('/p/')) return json(410, { error: 'the MCP must not use /p/ any more' });
    res.writeHead(404).end();
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${mock.address().port}`;

/** A fresh config folder per test, so saved keys never leak between tests or into ~/.config */
const configDirs = [];
function freshConfig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nextmsg-test-'));
  configDirs.push(dir);
  return dir;
}
const keyFile = (config) => path.join(config, 'nextmsg', 'key');

const env = (extra = {}) => ({
  ...process.env,
  NEXTMSG_KEY: 'nextmsg_live_mockkey',
  NEXTMSG_API_BASE: API,
  XDG_CONFIG_HOME: freshConfig(),
  ...extra
});

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
  let nextId = 1000;
  const request = (id, method, params) => {
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return nextFor(id);
  };
  return {
    send: (obj) => p.stdin.write(JSON.stringify(obj) + '\n'),
    request,
    notify: async (args) => (await request(++nextId, 'tools/call', { name: 'notify_human', arguments: args })).result,
    lines,
    stop: () => p.kill()
  };
}

const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] ?? process.platform;

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

await test('tools/list: notify_human with message, channel and pair_code, no key argument', async () => {
  const r = await mcp.request(4, 'tools/list');
  const tool = r.result.tools.find((t) => t.name === 'notify_human');
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['channel', 'message', 'pair_code']);
  assert.deepEqual(tool.inputSchema.required, ['message']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  // Guidance that keeps agents from spamming the phone, leaking secrets or retrying in a loop
  assert.match(tool.description, /not progress updates/);
  assert.match(tool.description, /actively chatting/);
  assert.match(tool.description, /Never include secrets/);
  assert.match(tool.description, /instead of retrying/);
  assert.match(tool.description, /pair_code/);
  assert.match(tool.inputSchema.properties.pair_code.description, /Never put a send key here/);
});

await test('tools/call sends to /v1/send with the key in the Authorization header', async () => {
  sent.length = 0;
  const r = await mcp.request(5, 'tools/call', { name: 'notify_human', arguments: { message: 'Deploy **done**', channel: 'CI' } });
  assert.equal(r.result.isError, false);
  assert.deepEqual(sent[0], { key: 'nextmsg_live_mockkey', body: { message: 'Deploy **done**', channel: 'ci' } });
});

await test('tools/call ignores a send_key argument (key only from NEXTMSG_KEY or the saved file)', async () => {
  sent.length = 0;
  await mcp.request(6, 'tools/call', { name: 'notify_human', arguments: { message: 'x', send_key: 'nextmsg_live_attacker' } });
  assert.equal(sent[0].key, 'nextmsg_live_mockkey');
});

await test('missing message is an error and sends nothing (no "undefined")', async () => {
  sent.length = 0;
  const r = await mcp.request(7, 'tools/call', { name: 'notify_human', arguments: {} });
  assert.equal(r.result.isError, true);
  assert.equal(sent.length, 0);
});

await test('300 emoji count as 300 characters and are sent', async () => {
  sent.length = 0;
  const r = await mcp.request(8, 'tools/call', { name: 'notify_human', arguments: { message: '👍'.repeat(300) } });
  assert.equal(r.result.isError, false);
  assert.equal(sent.length, 1);
});

await test('641 characters are rejected before sending', async () => {
  sent.length = 0;
  const r = await mcp.request(9, 'tools/call', { name: 'notify_human', arguments: { message: 'a'.repeat(641) } });
  assert.equal(r.result.isError, true);
  assert.equal(sent.length, 0);
});

await test('unknown tool returns -32602, unknown method -32601', async () => {
  assert.equal((await mcp.request(10, 'tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  assert.equal((await mcp.request(11, 'resources/list')).error.code, -32601);
});

await test('pair_code is ignored while NEXTMSG_KEY is set', async () => {
  sent.length = 0;
  claims.length = 0;
  const r = await mcp.notify({ message: 'x', pair_code: 'AAAA-AAAA' });
  assert.equal(r.isError, false);
  assert.equal(claims.length, 0);
  assert.equal(sent[0].key, 'nextmsg_live_mockkey');
});
mcp.stop();

await test('a stalled API times out with a readable error', async () => {
  const slow = startMcp({ NEXTMSG_KEY: 'nextmsg_live_slow', NEXTMSG_TIMEOUT_MS: '300' });
  const r = await slow.notify({ message: 'x' });
  slow.stop();
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /did not respond/);
});

await test('a rejected NEXTMSG_KEY says to update it', async () => {
  const bad = startMcp({ NEXTMSG_KEY: 'nextmsg_live_rotated' });
  const r = await bad.notify({ message: 'x' });
  bad.stop();
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /NEXTMSG_KEY was rejected/);
});

// ---------------- Pairing through the MCP tool ----------------
await test('not connected and no pair_code: asks for a code at once, no request made', async () => {
  sent.length = 0;
  claims.length = 0;
  const m = startMcp({ NEXTMSG_KEY: '' });
  const r = await m.notify({ message: 'x' });
  m.stop();
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Not connected to NextMsg yet/);
  assert.match(r.content[0].text, /Settings → Agents → Connect agent/);
  assert.equal(sent.length + claims.length, 0);
});

await test('pair_code: claims with "Claude Code on <OS>", saves the key (600), sends, never shows the key', async () => {
  sent.length = 0;
  claims.length = 0;
  liveCodes.add('K73M-QX9P');
  const config = freshConfig();
  const m = startMcp({ NEXTMSG_KEY: '', XDG_CONFIG_HOME: config });
  await m.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } });
  const r = await m.notify({ message: 'Build passed', pair_code: ' K73M-QX9P ' });
  assert.equal(r.isError, false, r.content[0].text);
  assert.match(r.content[0].text, /Connected to NextMsg as "Claude Code on /);
  assert.deepEqual(claims[0], { code: 'K73M-QX9P', name: `Claude Code on ${OS}` });
  const saved = readFileSync(keyFile(config), 'utf8').trim();
  assert.match(saved, /^nextmsg_agent_/);
  assert.equal(sent[0].key, saved);
  assert.ok(!r.content[0].text.includes(saved), 'the key must not reach the model');
  if (process.platform !== 'win32') {
    assert.equal(statSync(keyFile(config)).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(keyFile(config))).mode & 0o777, 0o700);
  }

  // The model repeats the burned code: ignored while the saved key works
  claims.length = 0;
  const again = await m.notify({ message: 'Second', pair_code: 'K73M-QX9P' });
  m.stop();
  assert.equal(again.isError, false, again.content[0].text);
  assert.match(again.content[0].text, /^✓ Notification sent/);
  assert.equal(claims.length, 0);
});

await test('a wrong code: readable error, nothing sent, nothing saved', async () => {
  sent.length = 0;
  const config = freshConfig();
  const m = startMcp({ NEXTMSG_KEY: '', XDG_CONFIG_HOME: config });
  const r = await m.notify({ message: 'x', pair_code: 'ZZZZ-ZZZZ' });
  m.stop();
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /wrong, already used or expired/);
  assert.match(r.content[0].text, /Nothing was sent/);
  assert.equal(sent.length, 0);
  assert.equal(existsSync(keyFile(config)), false);
});

await test('a revoked saved key: asks for a new code, and a new pair_code reconnects and sends', async () => {
  const config = freshConfig();
  liveCodes.add('AAAA-1111');
  const m = startMcp({ NEXTMSG_KEY: '', XDG_CONFIG_HOME: config });
  await m.notify({ message: 'first', pair_code: 'AAAA-1111' });
  const first = readFileSync(keyFile(config), 'utf8').trim();
  validKeys.delete(first); // revoked in the app

  const r = await m.notify({ message: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /revoked in NextMsg/);

  sent.length = 0;
  liveCodes.add('BBBB-2222');
  const re = await m.notify({ message: 'after revoke', pair_code: 'BBBB-2222' });
  m.stop();
  assert.equal(re.isError, false, re.content[0].text);
  const second = readFileSync(keyFile(config), 'utf8').trim();
  assert.notEqual(second, first);
  assert.equal(sent[0].key, second);
});

await test('a key file that cannot be written: still sends, says it lasts until the server stops', async () => {
  const blocker = path.join(freshConfig(), 'not-a-folder');
  writeFileSync(blocker, ''); // XDG_CONFIG_HOME is a file, so the folder can't be made
  liveCodes.add('CCCC-3333');
  sent.length = 0;
  const m = startMcp({ NEXTMSG_KEY: '', XDG_CONFIG_HOME: blocker });
  const r = await m.notify({ message: 'x', pair_code: 'CCCC-3333' });
  const next = await m.notify({ message: 'y' });
  m.stop();
  assert.equal(r.isError, false, r.content[0].text);
  assert.match(r.content[0].text, /couldn't be saved/);
  assert.equal(next.isError, false, next.content[0].text);
  assert.equal(sent.length, 2);
});

// ---------------- CLI ----------------
await test('CLI sends without a terminal, like a Claude Code hook (JSON on stdin)', async () => {
  sent.length = 0;
  const r = await runCli(['Claude Code finished', '--channel=claude-code'], { stdin: '{"hook_event_name":"Stop"}' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sent[0].body, { message: 'Claude Code finished', channel: 'claude-code' });
});

await test('CLI: -- lets a message start with "-"', async () => {
  sent.length = 0;
  const r = await runCli(['-c', 'ci', '--', '-1 tests failing']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sent[0].body.message, '-1 tests failing');
});

await test('CLI: words like "pair" stay messages', async () => {
  sent.length = 0;
  const r = await runCli(['pair', 'K73M-QX9P']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sent[0].body.message, 'pair K73M-QX9P');
});

await test('CLI: unknown option and no key fail with exit 1; no key explains --pair', async () => {
  assert.equal((await runCli(['--chanel', 'ci', 'x'])).code, 1);
  const r = await runCli(['hello'], { extraEnv: { NEXTMSG_KEY: '' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--pair <code>/);
});

await test('CLI: --pair saves the key, --status masks it, sending uses it, --disconnect deletes it', async () => {
  const config = freshConfig();
  const extraEnv = { NEXTMSG_KEY: '', XDG_CONFIG_HOME: config };
  claims.length = 0;
  liveCodes.add('DDDD-4444');
  const paired = await runCli(['--pair', 'DDDD-4444'], { extraEnv });
  assert.equal(paired.code, 0, paired.stderr);
  assert.match(paired.stdout, /Connected as "CLI on .*". Check your phone/);
  assert.equal(claims[0].name, `CLI on ${OS}`);
  const saved = readFileSync(keyFile(config), 'utf8').trim();
  assert.ok(!paired.stdout.includes(saved), 'the key is not printed');

  const status = await runCli(['--status'], { extraEnv });
  assert.match(status.stdout, /Using the saved key/);
  assert.ok(!status.stdout.includes(saved));

  sent.length = 0;
  const send = await runCli(['from the saved key'], { extraEnv });
  assert.equal(send.code, 0, send.stderr);
  assert.equal(sent[0].key, saved);

  // NEXTMSG_KEY wins over the saved key
  sent.length = 0;
  await runCli(['env wins'], { extraEnv: { XDG_CONFIG_HOME: config } });
  assert.equal(sent[0].key, 'nextmsg_live_mockkey');

  const gone = await runCli(['--disconnect'], { extraEnv });
  assert.equal(gone.code, 0);
  assert.match(gone.stdout, /revoke it in NextMsg/);
  assert.equal(existsSync(keyFile(config)), false);
});

await test('CLI: a revoked saved key says to pair again', async () => {
  const config = freshConfig();
  const extraEnv = { NEXTMSG_KEY: '', XDG_CONFIG_HOME: config };
  liveCodes.add('EEEE-5555');
  await runCli(['--pair', 'EEEE-5555'], { extraEnv });
  validKeys.delete(readFileSync(keyFile(config), 'utf8').trim());
  const r = await runCli(['x'], { extraEnv });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /revoked in NextMsg.*--pair/);
});

await test('CLI: a wrong --pair code fails with the server text', async () => {
  const r = await runCli(['--pair', 'NOPE-NOPE'], { extraEnv: { NEXTMSG_KEY: '' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wrong, already used or expired/);
});

mock.close();
for (const dir of configDirs) rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
