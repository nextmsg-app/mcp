# Changelog

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
