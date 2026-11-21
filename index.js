#!/usr/bin/env node

/**
 * NextMsg MCP Server & CLI
 *
 * Model Context Protocol (MCP) stdio server and command-line notifier for NextMsg.
 * Lets Claude Desktop, Claude Code, Cursor and other AI agents send push notifications
 * to a person's phone when a task finishes, fails or needs attention.
 *
 * Modes:
 *   nextmsg "message" [-c channel]   CLI: send one message and exit (works in scripts, CI and hooks)
 *   nextmsg --pair K73M-QX9P         CLI: connect this computer with a code from the app
 *   nextmsg --status | --disconnect  CLI: show or remove the saved key
 *   nextmsg  /  nextmsg --mcp        MCP server over stdio (what MCP clients launch)
 *
 * The key comes from NEXTMSG_KEY if set, otherwise from the file saved by pairing.
 * Zero dependencies. Requires Node.js >= 18.
 */

import readline from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const DEFAULT_API_BASE = process.env.NEXTMSG_API_BASE || 'https://api.nextmsg.app';
const MAX_MESSAGE_CHARS = 640;
const REQUEST_TIMEOUT_MS = Number(process.env.NEXTMSG_TIMEOUT_MS) || 15000; // env override is for tests
// Protocol versions this server speaks; the client's version is echoed back when it's one of these
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CONNECT_STEPS = 'NextMsg → Settings → Agents → Connect agent';

// ==========================================
// CLI
// ==========================================

function printHelp() {
  console.log(`
NextMsg MCP Server & CLI (v${VERSION})
https://nextmsg.app

CONNECT THIS COMPUTER (no key to copy):
  Open ${CONNECT_STEPS} on your phone, then run
  npx @nextmsg/mcp --pair K73M-QX9P

USAGE (CLI):
  npx @nextmsg/mcp "Build complete" --channel ci
  npx @nextmsg/mcp -- "-1 tests failing"     (use -- before a message that starts with "-")

OPTIONS:
  -c, --channel <name>   Channel tag, 1-32 chars [a-z0-9_-] (default: general)
  --pair <code>          Connect with a code from the app and save this computer's own key
  --status               Show which key is used
  --disconnect           Delete the saved key (revoke it in the app too)
  -k, --key <key>        Send key. Prefer --pair or the NEXTMSG_KEY environment variable:
                         a key on the command line ends up in shell history
  --mcp                  Run as an MCP server (the default when no message is given)
  -h, --help             Show help
  -v, --version          Show version

KEY: NEXTMSG_KEY if set, otherwise the key saved by --pair in
  ${keyFilePath()}

USAGE (MCP SERVER):
  Add to your MCP client config (Claude Desktop, Cursor, ...):

  {
    "mcpServers": {
      "nextmsg": {
        "command": "npx",
        "args": ["-y", "@nextmsg/mcp"]
      }
    }
  }

  The first time, the agent asks you for a code from the app. Or set
  "env": { "NEXTMSG_KEY": "nextmsg_live_..." } to use the send key from Settings.
`);
}

/** Parses CLI arguments into { message, channel, key, pair, status, disconnect }. */
function parseCliArgs(cliArgs) {
  let channel = 'general';
  let key = '';
  let pair = null;
  let status = false;
  let disconnect = false;
  const words = [];
  let optionsEnded = false;

  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];
    if (optionsEnded) {
      words.push(arg);
    } else if (arg === '--') {
      optionsEnded = true;
    } else if (arg === '-c' || arg === '--channel') {
      channel = cliArgs[++i] ?? '';
    } else if (arg.startsWith('--channel=')) {
      channel = arg.slice('--channel='.length);
    } else if (arg === '-k' || arg === '--key') {
      key = cliArgs[++i] ?? '';
    } else if (arg.startsWith('--key=')) {
      key = arg.slice('--key='.length);
    } else if (arg === '--pair') {
      pair = cliArgs[++i] ?? '';
    } else if (arg.startsWith('--pair=')) {
      pair = arg.slice('--pair='.length);
    } else if (arg === '--status') {
      status = true;
    } else if (arg === '--disconnect') {
      disconnect = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg} (use -- before a message that starts with "-")`);
    } else {
      words.push(arg);
    }
  }
  return { message: words.join(' '), channel, key, pair, status, disconnect };
}

async function runCli(cliArgs) {
  const options = parseCliArgs(cliArgs);
  const modes = [options.pair !== null, options.status, options.disconnect].filter(Boolean).length;
  if (modes > 1) throw new Error('Use only one of --pair, --status and --disconnect.');
  if (modes === 1 && options.message.trim()) {
    throw new Error('--pair, --status and --disconnect don\'t send a message; run the message separately.');
  }
  if (options.pair !== null) return cliPair(options.pair);
  if (options.status) return cliStatus();
  if (options.disconnect) return cliDisconnect();

  if (!options.message.trim()) {
    console.error('Error: Please provide a message to send.');
    printHelp();
    process.exit(1);
  }
  const optionKey = options.key.trim();
  const resolved = optionKey ? { key: optionKey, source: 'option' } : resolveKey();
  if (!resolved) {
    console.error(`Error: Not connected to NextMsg. In the app open ${CONNECT_STEPS}, then run:`);
    console.error('  npx @nextmsg/mcp --pair <code>');
    console.error('Or set the NEXTMSG_KEY environment variable to the send key from Settings.');
    process.exit(1);
  }

  try {
    const result = await sendMessage({ message: options.message, channel: options.channel, sendKey: resolved.key });
    console.log(`✓ Message delivered (channel: #${result.channel}, id: ${result.id})`);
  } catch (err) {
    if (err.status === 401) throw new Error(rejectedKeyText(resolved.source, 'cli'));
    throw err;
  }
}

async function cliPair(code) {
  if (!code.trim()) throw new Error(`--pair needs the code from ${CONNECT_STEPS}, e.g. --pair K73M-QX9P`);
  const hadKey = readSavedKey() !== null;
  const claim = await claimCode({ code, name: `CLI on ${osName()}` });
  let file;
  try {
    file = saveKey(claim.send_key);
  } catch (err) {
    // The code is used up: show the key once rather than lose it
    console.log(`✓ Connected as "${claim.name}", but the key couldn't be saved in ${keyFilePath()} (${err.message}).`);
    console.log('  Set it as NEXTMSG_KEY instead; it is shown only this once:');
    console.log(`  ${claim.send_key}`);
    return;
  }
  console.log(`✓ Connected as "${claim.name}". Check your phone.`);
  console.log(`  The key is saved in ${file} (only you can read it).`);
  if (hadKey) {
    console.log('  It replaces the key saved before. If that agent is no longer used, revoke it in NextMsg → Settings → Agents.');
  }
  if (envKey()) {
    console.log('  Note: NEXTMSG_KEY is set in this environment and is used instead of the saved key.');
  }
}

function cliStatus() {
  const file = keyFilePath();
  const saved = readSavedKey();
  if (envKey()) {
    console.log(`Using NEXTMSG_KEY from the environment (${maskKey(envKey())}).`);
    if (saved) console.log(`A saved key in ${file} (${maskKey(saved)}) is not used while NEXTMSG_KEY is set.`);
  } else if (saved) {
    console.log(`Using the saved key in ${file} (${maskKey(saved)}).`);
  } else {
    console.log(`Not connected. In the app open ${CONNECT_STEPS}, then run: npx @nextmsg/mcp --pair <code>`);
  }
}

function cliDisconnect() {
  const file = keyFilePath();
  try {
    unlinkSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`No saved key in ${file}.`);
      return;
    }
    throw err;
  }
  console.log(`✓ Deleted the saved key in ${file}.`);
  console.log('  It keeps working until you revoke it in NextMsg → Settings → Agents.');
}

// ==========================================
// Saved key (written by pairing)
// ==========================================

/** $XDG_CONFIG_HOME/nextmsg/key, else %APPDATA%\nextmsg\key on Windows, else ~/.config/nextmsg/key */
function keyFilePath() {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'nextmsg', 'key');
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'nextmsg', 'key');
  return path.join(os.homedir(), '.config', 'nextmsg', 'key');
}

function readSavedKey() {
  try {
    const key = readFileSync(keyFilePath(), 'utf8').trim();
    return /^nextmsg_[a-z]+_[0-9A-Za-z]+$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** Writes the key readable only by this user (folder 700, file 600), replacing it atomically. */
function saveKey(key) {
  const file = keyFilePath();
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows, or a folder we don't own: the file mode below still applies where supported
  }
  // A new file every time ('wx'), so the 600 mode always applies and nothing else is followed
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${key}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Never created
    }
    throw err;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: the per-user folder protects it
  }
  return file;
}

// A key paired in this MCP session whose file couldn't be written (read-only disk, container)
let sessionKey = null;
// The pairing in flight, so parallel tool calls with the same code share one claim
let pendingPair = null;

/** NEXTMSG_KEY without the whitespace or newline secret stores and files often add */
function envKey() {
  return (process.env.NEXTMSG_KEY || '').trim();
}

/**
 * NEXTMSG_KEY always wins (CI, Docker, explicit setups); then the saved key. A session key
 * exists only when it couldn't be written, so it is newer than whatever the file holds.
 */
function resolveKey() {
  if (envKey()) return { key: envKey(), source: 'env' };
  const saved = sessionKey ?? readSavedKey();
  return saved ? { key: saved, source: 'file' } : null;
}

/** "nextmsg_agent_3f9a…" or "nextmsg_live_…" without the secret part */
function maskKey(key) {
  const match = /^(nextmsg_[a-z]+_)(.{0,4})/.exec(key);
  return match ? `${match[1]}${match[2]}…` : 'unrecognized format';
}

function rejectedKeyText(source, mode) {
  if (source === 'file') {
    return mode === 'cli'
      ? `This computer's key was revoked in NextMsg, or its inbox was deleted. Get a new code from ${CONNECT_STEPS} and run: npx @nextmsg/mcp --pair <code>`
      : `This agent's key was revoked in NextMsg, or its inbox was deleted. Ask the user for a new code from ${CONNECT_STEPS}, then call notify_human again with pair_code.`;
  }
  const where = source === 'option' ? 'The key given with --key' : 'NEXTMSG_KEY';
  return `${where} was rejected: it was rotated or revoked, or its inbox was deleted. Update it with the key from the app.`;
}

/** Docker and similar: the saved key lives only as long as the container's filesystem */
function inContainer() {
  try {
    readFileSync('/.dockerenv');
    return true;
  } catch {
    return Boolean(process.env.container);
  }
}

function osName() {
  return { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] ?? process.platform;
}

// MCP clients' handshake names, as people know them
const CLIENT_NAMES = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude Desktop',
  'cursor-vscode': 'Cursor',
  cursor: 'Cursor',
  'codex-mcp-client': 'Codex',
  codex: 'Codex',
  'Visual Studio Code': 'VS Code',
  'windsurf-client': 'Windsurf',
  antigravity: 'Antigravity',
  zed: 'Zed',
  cline: 'Cline',
  goose: 'Goose',
  'gemini-cli': 'Gemini CLI'
};

/** "Claude Code on macOS". Never the hostname: it often holds the person's name. */
function agentName(clientName) {
  let app = CLIENT_NAMES[clientName];
  if (!app && typeof clientName === 'string') {
    app = [...clientName.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim()].slice(0, 24).join('');
  }
  return `${app || 'AI agent'} on ${osName()}`;
}

// ==========================================
// NextMsg API client
// ==========================================

/** fetch with the timeout and readable network errors */
async function request(url, init) {
  try {
    // The API never redirects these calls; following one would send the key somewhere else
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`NextMsg did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new Error(`Could not reach NextMsg: ${err.message}`);
  }
}

async function errorDetail(response) {
  try {
    const body = await response.json();
    if (body && body.error) return body.error;
  } catch {
    // Body wasn't JSON; keep the status
  }
  return `HTTP ${response.status}`;
}

function apiUrl(apiBase, pathname) {
  return `${apiBase.replace(/\/$/, '')}${pathname}`;
}

/**
 * Validates and sends one message with the key in the Authorization header (agent keys only
 * work there). Throws an Error with a readable message, and `status` for HTTP errors.
 */
async function sendMessage({ message, channel = 'general', sendKey, apiBase = DEFAULT_API_BASE }) {
  if (!sendKey) {
    throw new Error('No NextMsg key is configured.');
  }
  if (typeof message !== 'string') {
    throw new Error('"message" must be a string.');
  }

  const cleanMessage = message.trim();
  if (!cleanMessage) {
    throw new Error('Message cannot be empty.');
  }
  // The API counts Unicode code points (an emoji is 1), not JavaScript string units
  const length = [...cleanMessage].length;
  if (length > MAX_MESSAGE_CHARS) {
    throw new Error(`Message is too long: ${length} characters (limit ${MAX_MESSAGE_CHARS}).`);
  }

  const cleanChannel = (typeof channel === 'string' && channel.trim() ? channel : 'general').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(cleanChannel)) {
    throw new Error('Channel must be 1-32 lowercase characters [a-z0-9_-].');
  }

  const response = await request(apiUrl(apiBase, '/v1/send'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sendKey}` },
    body: JSON.stringify({ message: cleanMessage, channel: cleanChannel })
  });

  if (!response.ok) {
    const detail = await errorDetail(response);
    const fail = (text) => Object.assign(new Error(text), { status: response.status });
    switch (response.status) {
      case 401:
        throw fail('The key is invalid, was rotated or revoked, or its inbox was deleted.');
      case 402:
        throw fail('The free plan limit (100 messages a month) is reached. The recipient can upgrade in the app.');
      case 413:
        throw fail('The message is too large.');
      case 429:
        throw fail('Rate limited. Wait before retrying; do not retry in a loop.');
      default:
        throw fail(`Failed to send: ${detail}`);
    }
  }

  const result = await response.json();
  return { ...result, channel: cleanChannel };
}

/** Exchanges a pickup code for this computer's own key, once. Returns { send_key, name }. */
async function claimCode({ code, name, apiBase = DEFAULT_API_BASE }) {
  const response = await request(apiUrl(apiBase, '/v1/agent/claim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: String(code).trim(), name })
  });
  if (!response.ok) {
    if (response.status === 429) throw new Error('Too many attempts. Wait a minute, then try again with a new code.');
    if (response.status === 404) throw new Error('This NextMsg server does not support connecting with a code yet.');
    throw new Error(await errorDetail(response));
  }
  const body = await response.json();
  const key = typeof body?.send_key === 'string' ? body.send_key.trim() : '';
  if (!/^nextmsg_[a-z]+_[0-9A-Za-z]+$/.test(key)) throw new Error('NextMsg sent an unexpected answer.');
  return { send_key: key, name: body.name || name };
}

// ==========================================
// MCP server (JSON-RPC 2.0 over stdio)
// ==========================================

// The key is read only from NEXTMSG_KEY or the saved file, never from tool arguments, so it never
// passes through the model's context, transcripts or logs. pair_code is a single-use 5-minute code.
const TOOLS = [
  {
    name: 'notify_human',
    description:
      "Send a push notification to the user's phone via NextMsg. Use it when an autonomous task, build, test run, deployment or long-running workflow finishes, fails, or needs the user's input, and whenever the user asks to be notified. " +
      "Send one notification per outcome, not progress updates. Don't use it to answer a user who is actively chatting with you. " +
      'Never include secrets, tokens or personal data: the text appears on the lock screen. ' +
      'Keep it short and specific: what happened, where, and what (if anything) the user should do. ' +
      'If sending fails, tell the user in the conversation instead of retrying. ' +
      `If the result says NextMsg isn't connected, ask the user for the code from ${CONNECT_STEPS} and call again with pair_code.`,
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MESSAGE_CHARS,
          description:
            'The notification text (1-640 characters). Supports **bold**, *italic*, ~~strikethrough~~ and `code`. Links are shown as plain text.'
        },
        channel: {
          type: 'string',
          pattern: '^[a-z0-9_-]{1,32}$',
          default: 'general',
          description: 'Optional channel to group messages, e.g. ci, deploy, infra, ml. 1-32 lowercase characters [a-z0-9_-].'
        },
        pair_code: {
          type: 'string',
          maxLength: 20,
          description:
            `Only when NextMsg isn't connected yet: the 8-character code the user got from ${CONNECT_STEPS} (like K73M-QX9P). Connects this computer once; leave it out afterwards. Never put a send key here.`
        }
      },
      required: ['message'],
      additionalProperties: false
    }
  }
];

function sendJsonRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function toolResult(id, text, isError) {
  sendJsonRpc({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });
}

const NOT_CONNECTED_TEXT =
  `Not connected to NextMsg yet. Ask the user to open ${CONNECT_STEPS} and tell you the code, then call notify_human again with pair_code. ` +
  "If they can't find Connect agent, they need the latest NextMsg app, or they can set NEXTMSG_KEY to the send key from Settings.";

/** notify_human: returns { text, isError } */
async function notifyHuman(toolArgs, clientName) {
  if (typeof toolArgs.message !== 'string' || !toolArgs.message.trim()) {
    return { text: 'Error: "message" is required and must be non-empty text.', isError: true };
  }
  const pairCode = typeof toolArgs.pair_code === 'string' ? toolArgs.pair_code.trim() : '';
  let resolved = resolveKey();
  let connectedAs = null;
  let saveError = null;

  const pair = async () => {
    if (!pendingPair) {
      // Claim and save once, however many calls are waiting for this pairing
      pendingPair = claimCode({ code: pairCode, name: agentName(clientName) })
        .then((claim) => {
          try {
            saveKey(claim.send_key);
            sessionKey = null;
            return { claim, saveError: null };
          } catch (err) {
            // Still usable until this server stops
            sessionKey = claim.send_key;
            return { claim, saveError: err.message };
          }
        })
        .finally(() => {
          pendingPair = null;
        });
    }
    const result = await pendingPair;
    connectedAs = result.claim.name;
    resolved = { key: result.claim.send_key, source: 'file' };
    saveError = result.saveError;
  };

  if (!resolved) {
    if (!pairCode) return { text: NOT_CONNECTED_TEXT, isError: true };
    try {
      await pair();
    } catch (err) {
      return {
        text: `Couldn't connect to NextMsg: ${err.message} Ask the user for a new code from ${CONNECT_STEPS}. Nothing was sent.`,
        isError: true
      };
    }
  }

  const send = () => sendMessage({ message: toolArgs.message, channel: toolArgs.channel, sendKey: resolved.key });
  const failed = (err) => {
    const text = err.status === 401 ? rejectedKeyText(resolved.source, 'mcp') : err.message;
    if (!connectedAs) return { text: `Failed to send the notification: ${text}`, isError: true };
    const kept = saveError ? ` The key couldn't be saved (${saveError}), so it works only until this MCP server stops.` : '';
    return { text: `Connected to NextMsg as "${connectedAs}", but sending failed: ${text}${kept}`, isError: true };
  };

  let res;
  try {
    res = await send();
  } catch (err) {
    // A revoked saved key with a new code: connect again and retry once. A code is otherwise
    // ignored while a key works (models repeat optional arguments; a burned code must not fail a send).
    if (!(err.status === 401 && resolved.source === 'file' && pairCode && !connectedAs)) return failed(err);
    try {
      await pair();
    } catch (pairErr) {
      return {
        text: `This agent's key was revoked in NextMsg, and connecting again failed: ${pairErr.message} Ask the user for a new code from ${CONNECT_STEPS}. Nothing was sent.`,
        isError: true
      };
    }
    try {
      res = await send();
    } catch (retryErr) {
      return failed(retryErr);
    }
  }

  const sent = `(channel: #${res.channel}, id: ${res.id})`;
  if (connectedAs) {
    const kept = saveError
      ? `The key couldn't be saved (${saveError}), so it works only until this MCP server stops.`
      : inContainer()
        ? `The key is saved in ${keyFilePath()} inside this container: it's lost when the container is removed unless that folder is a mounted volume (or set NEXTMSG_KEY).`
        : 'The key is saved on this computer, so later notifications need no code.';
    return { text: `✓ Connected to NextMsg as "${connectedAs}" and sent the notification ${sent}. ${kept}`, isError: false };
  }
  return { text: `✓ Notification sent ${sent}`, isError: false };
}

function runMcpServer() {
  // A client that goes away closes our stdout; exit quietly instead of crashing on EPIPE
  process.stdout.on('error', () => process.exit(0));

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // From the initialize handshake, for the agent's name when it connects ("Claude Code on macOS")
  let clientName = null;

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      sendJsonRpc({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON' } });
      return;
    }

    const { id, method, params } = req ?? {};

    // Notifications (no id) never get a response
    if (id === undefined || id === null) return;

    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
          if (typeof params?.clientInfo?.name === 'string') clientName = params.clientInfo.name;
          sendJsonRpc({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'nextmsg', version: VERSION }
            }
          });
          break;
        }

        case 'ping':
          sendJsonRpc({ jsonrpc: '2.0', id, result: {} });
          break;

        case 'tools/list':
          sendJsonRpc({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
          break;

        case 'tools/call': {
          if (params?.name !== 'notify_human') {
            sendJsonRpc({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
            break;
          }
          const { text, isError } = await notifyHuman(params.arguments ?? {}, clientName);
          toolResult(id, text, isError);
          break;
        }

        default:
          sendJsonRpc({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (err) {
      sendJsonRpc({ jsonrpc: '2.0', id, error: { code: -32603, message: `Internal error: ${err.message}` } });
    }
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// ==========================================
// Entry point (last, so every declaration above is initialized)
// ==========================================

const args = process.argv.slice(2);
// Options count only before "--": `nextmsg -- "-v"` sends "-v"
const dashDash = args.indexOf('--');
const options = dashDash === -1 ? args : args.slice(0, dashDash);

if (options.includes('-h') || options.includes('--help')) {
  printHelp();
  process.exit(0);
}

if (options.includes('-v') || options.includes('--version')) {
  console.log(`@nextmsg/mcp v${VERSION}`);
  process.exit(0);
}

// A message argument means CLI mode, whatever stdin is: scripts, CI jobs and Claude Code hooks
// run without a terminal (and hooks pipe JSON on stdin), and must still send.
// No arguments, or --mcp, means MCP server mode.
if (args.length > 0 && !options.includes('--mcp')) {
  runCli(args).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else {
  runMcpServer();
}
