# @nextmsg/mcp

Official [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server and CLI notifier for [NextMsg](https://nextmsg.app).

NextMsg is a one-way push notification inbox for developers. AI agents, autonomous scripts, and long-running workflows use it to notify your phone when tasks finish, fail, or need attention.

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
      "args": ["-y", "@nextmsg/mcp"],
      "env": {
        "NEXTMSG_KEY": "nextmsg_live_YOUR_KEY_HERE"
      }
    }
  }
}
```

### 2. Cursor
Go to **Settings** → **Features** → **MCP Servers** → **Add New MCP Server**:
- **Name**: `nextmsg`
- **Type**: `command`
- **Command**: `npx -y @nextmsg/mcp`
- Set environment variable `NEXTMSG_KEY` to your send key.

### 3. Claude Code Hook
You can also set up a hook in `~/.claude/settings.json` so Claude Code pings your phone whenever it finishes a turn. Set `NEXTMSG_KEY` in your shell profile (or in the `env` block of `settings.json`):

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
# Set your key once
export NEXTMSG_KEY="nextmsg_live_..."

# Send alert
npx @nextmsg/mcp "Model training complete: loss 0.12" --channel ml

# A message that starts with "-"
npx @nextmsg/mcp -- "-1 tests failing"
```

`--key` works too, but prefer `NEXTMSG_KEY`: a key on the command line ends up in shell history. If a key leaks, rotate it in the app (Settings).

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

The send key is read only from the `NEXTMSG_KEY` environment variable, never from tool arguments, so it never passes through the model's context or transcripts.

---

## License
[MIT](./LICENSE)
