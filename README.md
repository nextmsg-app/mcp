# @nextmsg/mcp

[![npm](https://img.shields.io/npm/v/@nextmsg/mcp)](https://www.npmjs.com/package/@nextmsg/mcp)
[![test](https://github.com/nextmsg-app/mcp/actions/workflows/test.yml/badge.svg)](https://github.com/nextmsg-app/mcp/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/@nextmsg/mcp)](LICENSE)
[![@nextmsg/mcp MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/nextmsg-app/mcp/badges/score.svg)](https://glama.ai/mcp/servers/nextmsg-app/mcp)
[![NextMsg MCP on mcprush](https://mcprush.com/badge/nextmsg-mcp/score.svg)](https://mcprush.com/to/nextmsg-mcp?ref=badge)

Official [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server and CLI notifier for [NextMsg](https://nextmsg.app).

- **npm:** [npmjs.com/package/@nextmsg/mcp](https://www.npmjs.com/package/@nextmsg/mcp), run it with `npx -y @nextmsg/mcp`
- **Source:** [github.com/nextmsg-app/mcp](https://github.com/nextmsg-app/mcp)
- **Guides:** [nextmsg.app/guides](https://nextmsg.app/guides/) (Claude Code, Cursor, Codex, Antigravity, GitHub Actions, AWS and more)

NextMsg is a one-way push notification inbox for developers. AI agents, autonomous scripts, and long-running workflows use it to notify your phone when tasks finish, fail, or need attention.

**Use it to answer questions like:**

- How can Claude Code, Cursor or another AI agent notify me when a task is done? → [Claude Code guide](https://nextmsg.app/guides/claude-code), [Cursor](https://nextmsg.app/guides/cursor), [Codex](https://nextmsg.app/guides/codex), [Antigravity and Gemini](https://nextmsg.app/guides/antigravity)
- Which MCP server can send a notification to my phone? → this one: `npx -y @nextmsg/mcp`, setup below
- How do I get a phone notification when a GitHub Action fails? → [GitHub Actions guide](https://nextmsg.app/guides/github-actions)
- How do I know when a cron job or backup finishes? → [cron jobs guide](https://nextmsg.app/guides/cron-jobs)
- How do I send server alerts to my phone without Telegram or Slack? → [server alerts guide](https://nextmsg.app/guides/server-alerts)

Without MCP, any program can send with one HTTP request: see the [Send API](https://nextmsg.app/docs).

---

## Connect your phone

1. Install the NextMsg app:
   - iPhone: [App Store](https://apps.apple.com/app/nextmsg-push-notifications/id6831546010)
   - Android: [Google Play](https://play.google.com/store/apps/details?id=app.nextmsg)
2. Open it. Your inbox is created on the spot: no account, no email.
3. Connect your agent with a code, or use your send key (below).

### With a code (no key to copy)

Each computer or agent gets its own key, which you can rename or revoke on its own in the app:

1. In the app: **Settings → Agents → Connect agent**. It shows a code like `K73M-QX9P` for 5 minutes.
2. Give the code to your agent in the chat: with the MCP server set up (no `NEXTMSG_KEY` needed), the agent asks for it the first time. Or run `npx -y @nextmsg/mcp --pair K73M-QX9P` in a terminal.

The key is saved in `~/.config/nextmsg/key` (`$XDG_CONFIG_HOME/nextmsg/key` if set, `%APPDATA%\nextmsg\key` on Windows), readable only by you. Never share the code: whoever uses it within 5 minutes can send you notifications.

In Docker, the saved key lives in the container and is gone when it's removed: mount a volume at `/home/node/.config/nextmsg`, or pass `NEXTMSG_KEY`.

### With your send key

In the app, go to **Settings → Send key** and copy it (`nextmsg_live_…`). Put it in the `NEXTMSG_KEY` environment variable, never in code or repos. When set, `NEXTMSG_KEY` is always used instead of a saved key. If it leaks, rotate it in the app (Settings). Help: [nextmsg.app/support](https://nextmsg.app/support).

---

## Quickstart: Use with AI Tools

### 1. Claude Desktop
Add to your `claude_desktop_config.json`:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "nextmsg": {
      "command": "npx",
      "args": ["-y", "@nextmsg/mcp"]
    }
  }
}
```

The first time, the agent asks you for a code from **Settings → Agents → Connect agent**. To use your send key instead, add `"env": { "NEXTMSG_KEY": "nextmsg_live_YOUR_KEY_HERE" }` next to `args`.

### 2. Cursor
Go to **Settings** → **Features** → **MCP Servers** → **Add New MCP Server**:
- **Name**: `nextmsg`
- **Type**: `command`
- **Command**: `npx -y @nextmsg/mcp`
- No key needed: the agent asks for a code from **Settings → Agents → Connect agent** the first time. Or set the environment variable `NEXTMSG_KEY` to your send key.

### 3. Claude Code Hook
You can also set up a hook in `~/.claude/settings.json` so Claude Code pings your phone whenever it finishes a turn. Connect once with `npx -y @nextmsg/mcp --pair YOUR-CODE` (the hook then uses the saved key), or set `NEXTMSG_KEY` in your shell profile (or in the `env` block of `settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y @nextmsg/mcp 'Claude Code finished task' --channel claude-code"
          }
        ]
      }
    ]
  }
}
```

### 4. Direct CLI Usage
Send messages directly from your terminal or CI pipelines:

```bash
# Connect once with a code from the app (Settings → Agents → Connect agent)
npx @nextmsg/mcp --pair K73M-QX9P
# ...or set the send key (CI, Docker)
export NEXTMSG_KEY="nextmsg_live_..."

# Send alert
npx @nextmsg/mcp "Model training complete: loss 0.12" --channel ml

# A message that starts with "-"
npx @nextmsg/mcp -- "-1 tests failing"
```

`--status` shows which key is used; `--disconnect` deletes the saved key (revoke it in the app too, under Settings → Agents). `--key` works too, but prefer `--pair` or `NEXTMSG_KEY`: a key on the command line ends up in shell history. If a key leaks, rotate it in the app (Settings).

---

## MCP Tools Provided

### `notify_human`
Sends a push notification to your phone. The agent uses it when a task finishes, fails or needs your input, and whenever you ask to be notified. Its description tells the agent to:

- send one notification per outcome, not progress updates
- answer in the conversation instead when you're actively chatting
- never include secrets, tokens or personal data (the text shows on the lock screen)
- report a failed send in the conversation instead of retrying

**Parameters:**
- `message` *(string, required)*: Alert text (1–640 characters). Supports markdown (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``). Links are inert text.
- `channel` *(string, optional, default: "general")*: Channel category tag (1–32 lowercase chars `a-z0-9_-`). E.g. `ci`, `deploy`, `ml`, `infra`.
- `pair_code` *(string, optional)*: Only when not connected yet: the code from **Settings → Agents → Connect agent**. The server claims it, saves this computer's key and sends the message in the same call. Ignored once a key works.

The key is read only from `NEXTMSG_KEY` or the saved key file, never from tool arguments, so it never passes through the model's context or transcripts. It is sent only to the NextMsg API, in the `Authorization` header, and redirects are refused, so it can't be forwarded anywhere else. See [SECURITY.md](SECURITY.md) for how keys are handled and how to report a problem. The tool result never contains it. The agent is named after the MCP client and the OS (like "Claude Code on macOS"), never the computer's hostname.

---

## License
[MIT](./LICENSE)
