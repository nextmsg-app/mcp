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
 *   nextmsg  /  nextmsg --mcp        MCP server over stdio (what MCP clients launch)
 *
 * Zero dependencies. Requires Node.js >= 18.
 */

import readline from 'node:readline';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const DEFAULT_API_BASE = process.env.NEXTMSG_API_BASE || 'https://api.nextmsg.app';
const MAX_MESSAGE_CHARS = 640;
const REQUEST_TIMEOUT_MS = Number(process.env.NEXTMSG_TIMEOUT_MS) || 15000; // env override is for tests
// Protocol versions this server speaks; the client's version is echoed back when it's one of these
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ==========================================
// Entry point
// ==========================================

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  printHelp();
  process.exit(0);
}

if (args.includes('-v') || args.includes('--version')) {
  console.log(`@nextmsg/mcp v${VERSION}`);
  process.exit(0);
}

// A message argument means CLI mode, whatever stdin is: scripts, CI jobs and Claude Code hooks
// run without a terminal (and hooks pipe JSON on stdin), and must still send.
// No arguments, or --mcp, means MCP server mode.
if (args.length > 0 && !args.includes('--mcp')) {
  runCli(args).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else {
  runMcpServer();
}

// ==========================================
// CLI
// ==========================================

function printHelp() {
  console.log(`
NextMsg MCP Server & CLI (v${VERSION})
https://nextmsg.app

USAGE (CLI):
  export NEXTMSG_KEY="nextmsg_live_..."
  npx @nextmsg/mcp "Build complete" --channel ci
  npx @nextmsg/mcp -- "-1 tests failing"     (use -- before a message that starts with "-")

OPTIONS:
  -c, --channel <name>   Channel tag, 1-32 chars [a-z0-9_-] (default: general)
  -k, --key <key>        Send key. Prefer the NEXTMSG_KEY environment variable:
                         a key on the command line ends up in shell history
  --mcp                  Run as an MCP server (the default when no message is given)
  -h, --help             Show help
  -v, --version          Show version

USAGE (MCP SERVER):
  Add to your MCP client config (Claude Desktop, Cursor, ...):

  {
    "mcpServers": {
      "nextmsg": {
        "command": "npx",
        "args": ["-y", "@nextmsg/mcp"],
        "env": { "NEXTMSG_KEY": "nextmsg_live_..." }
      }
    }
  }
`);
}

/** Parses CLI arguments. Exported shape: { message, channel, key }. */
function parseCliArgs(cliArgs) {
  let channel = 'general';
  let key = process.env.NEXTMSG_KEY || '';
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
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg} (use -- before a message that starts with "-")`);
    } else {
      words.push(arg);
    }
  }
  return { message: words.join(' '), channel, key };
}

async function runCli(cliArgs) {
  const { message, channel, key } = parseCliArgs(cliArgs);

  if (!message.trim()) {
    console.error('Error: Please provide a message to send.');
    printHelp();
    process.exit(1);
  }
  if (!key) {
    console.error('Error: Missing NextMsg send key. Set the NEXTMSG_KEY environment variable.');
    process.exit(1);
  }

  const result = await sendMessage({ message, channel, sendKey: key });
  console.log(`✓ Message delivered (channel: #${result.channel}, id: ${result.id})`);
}

// ==========================================
// NextMsg API client
// ==========================================

/** Validates and sends one message. Throws an Error with a readable message on any failure. */
async function sendMessage({ message, channel = 'general', sendKey, apiBase = DEFAULT_API_BASE }) {
  if (!sendKey) {
    throw new Error('NEXTMSG_KEY is not configured.');
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

  const endpoint = `${apiBase.replace(/\/$/, '')}/p/${encodeURIComponent(sendKey)}`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: cleanMessage, channel: cleanChannel }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`NextMsg did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new Error(`Could not reach NextMsg: ${err.message}`);
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body && body.error) detail = body.error;
    } catch {
      // Body wasn't JSON; keep the status
    }
    switch (response.status) {
      case 401:
        throw new Error('The send key is invalid or was rotated. Update NEXTMSG_KEY.');
      case 402:
        throw new Error('The free plan limit (100 messages a month) is reached. The recipient can upgrade in the app.');
      case 413:
        throw new Error('The message is too large.');
      case 429:
        throw new Error('Rate limited. Wait before retrying; do not retry in a loop.');
      default:
        throw new Error(`Failed to send: ${detail}`);
    }
  }

  const result = await response.json();
  return { ...result, channel: cleanChannel };
}

// ==========================================
// MCP server (JSON-RPC 2.0 over stdio)
// ==========================================

// The send key is read only from NEXTMSG_KEY, never from tool arguments, so it never
// passes through the model's context, transcripts or logs.
const TOOLS = [
  {
    name: 'notify_human',
    description:
      "Send a push notification to the user's phone via NextMsg. Use it when an autonomous task, build, test run, deployment or long-running workflow finishes, fails, or needs the user's input, and whenever the user asks to be notified. " +
      "Send one notification per outcome, not progress updates. Don't use it to answer a user who is actively chatting with you. " +
      'Never include secrets, tokens or personal data: the text appears on the lock screen. ' +
      'Keep it short and specific: what happened, where, and what (if anything) the user should do. ' +
      'If sending fails, tell the user in the conversation instead of retrying.',
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

function runMcpServer() {
  // A client that goes away closes our stdout; exit quietly instead of crashing on EPIPE
  process.stdout.on('error', () => process.exit(0));

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

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
          const toolArgs = params.arguments ?? {};
          const sendKey = process.env.NEXTMSG_KEY;
          if (!sendKey) {
            toolResult(
              id,
              'Error: NEXTMSG_KEY is not set. Add it to the "env" of the nextmsg server in your MCP client configuration.',
              true
            );
            break;
          }
          if (typeof toolArgs.message !== 'string' || !toolArgs.message.trim()) {
            toolResult(id, 'Error: "message" is required and must be non-empty text.', true);
            break;
          }
          try {
            const res = await sendMessage({ message: toolArgs.message, channel: toolArgs.channel, sendKey });
            toolResult(id, `✓ Notification sent (channel: #${res.channel}, id: ${res.id})`, false);
          } catch (err) {
            toolResult(id, `Failed to send the notification: ${err.message}`, true);
          }
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
