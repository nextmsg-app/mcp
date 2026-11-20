# Security policy

## Reporting a vulnerability

Please email **hello@nextmsg.app** with "Security" in the subject. Do not open a public issue for security problems.

Include what you found, how to reproduce it, and the version (`npx -y @nextmsg/mcp --version`). We aim to reply within a few days, and we credit reporters in the changelog unless they prefer not to be named.

This covers the `@nextmsg/mcp` package and its Docker image. Issues with the NextMsg apps, website or API (`api.nextmsg.app`) go to the same address.

## Supported versions

Only the latest release on npm gets security fixes.

## Handling of your send key

As an MCP server it reads the send key only from the `NEXTMSG_KEY` environment variable, never from tool arguments. The key is sent only to the NextMsg API over HTTPS (`api.nextmsg.app`, unless you set `NEXTMSG_API_BASE`). If your key leaks, rotate it in the app (Settings).
