# Security policy

## Reporting a vulnerability

Please email **hello@nextmsg.app** with "Security" in the subject. Do not open a public issue for security problems.

Include what you found, how to reproduce it, and the version (`npx -y @nextmsg/mcp --version`). We aim to reply within a few days, and we credit reporters in the changelog unless they prefer not to be named.

This covers the `@nextmsg/mcp` package and its Docker image. Issues with the NextMsg apps, website or API (`api.nextmsg.app`) go to the same address.

## Supported versions

Only the latest release on npm gets security fixes.

## Handling of your key

The key comes from the `NEXTMSG_KEY` environment variable or, after connecting with a code (`--pair`, or `pair_code` on `notify_human`), from `~/.config/nextmsg/key` (`$XDG_CONFIG_HOME/nextmsg/key` if set, `%APPDATA%\nextmsg\key` on Windows), a file only you can read (600, in a 700 folder). It is never taken from tool arguments and never appears in tool results. A pickup code works once and for 5 minutes.

The key is sent only to the NextMsg API over HTTPS (`api.nextmsg.app`, unless you set `NEXTMSG_API_BASE`), in the `Authorization` header; redirects are refused.

If a key leaks, revoke it in the app under Settings → Send keys; each key is revoked on its own (the Default key is rotated there instead).
