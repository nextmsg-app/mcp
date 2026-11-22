# Changelog

## 1.1.2

- `NEXTMSG_KEY` is optional in the MCP Registry listing and `mcp.json`: without it, the agent asks for a code from Settings → Agents → Connect agent
- README starts with connecting by code; the send key is the alternative

## 1.1.1

- Requests refuse redirects, so a key is never sent anywhere but the API
- Parallel `notify_human` calls with the same `pair_code` share one claim instead of the second failing
- In a container, the connect message says the saved key is lost with the container unless the folder is a volume
- Client name for Gemini CLI
- Release workflow: actions pinned to commit SHAs, npm pinned to 11.21.3
- `SECURITY.md` describes the saved key file and agent keys

## 1.1.0

- **Connect with a code:** `npx @nextmsg/mcp --pair K73M-QX9P` with a code from the app (Settings → Agents → Connect agent), or `notify_human` with the new optional `pair_code` argument. Each computer gets its own key, saved in `~/.config/nextmsg/key` (XDG, `%APPDATA%` on Windows; folder 700, file 600). `NEXTMSG_KEY` still wins when set
- `--status` shows which key is used, `--disconnect` deletes the saved key
- Without a key, `notify_human` tells the agent to ask for a code instead of failing
- Sends with `POST /v1/send` and the key in the `Authorization` header instead of `/p/{key}` (required for agent keys, keeps keys out of URLs)
- A rejected key says what to do for its source: pair again for a saved key, update `NEXTMSG_KEY` for the environment

- Dockerfile (Node 24 Alpine, no dependencies, runs as the `node` user) for the Docker MCP Catalog; CI builds the image and checks it lists `notify_human`
- `mcp.json` (Open Plugins) so directories can detect the server
- README: mcprush badge
- `SECURITY.md`: how to report a vulnerability

## 1.0.7

- README: opens with the questions it answers, each linked to its guide, and links the Send API page (nextmsg.app/docs)

## 1.0.6

- Listed in the official MCP Registry as `io.github.nextmsg-app/mcp` (`mcpName` in package.json, `server.json`); releases publish there automatically

## 1.0.5

- README: Get a send key section with App Store and Google Play links

## 1.0.4

- A rejected send key (401) now says the inbox may have been deleted, not only that the key was rotated
- CI uses actions/checkout and actions/setup-node v7

## 1.0.3

- Package metadata: repository and issue links point to github.com/nextmsg-app/mcp
- README: npm, CI and license badges; links to the source and the guides at nextmsg.app/guides
- Published from GitHub Actions with npm provenance

## 1.0.2

- Send keys use the `nextmsg_live_` prefix

## 1.0.1

- The `notify_human` description tells agents when not to notify: one message per outcome, no progress updates, no secrets, no retry loops

## 1.0.0

- First release: MCP server with the `notify_human` tool, and a CLI for scripts, CI and hooks
