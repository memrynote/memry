---
tags:
  - tech/electron
  - reference
project:
  - memrynote Launch
area: Learning
language: javascript
level: intermediate
---
## Native module ABI

`better-sqlite3` must be rebuilt against the *target* runtime.

```bash
# For node tests
pnpm rebuild better-sqlite3

# For electron app
pnpm exec electron-rebuild -f -o better-sqlite3
```

> [!error]
> Forget this and you'll get `ERR_DLOPEN_FAILED` and the app falls through to the welcome screen. Spent two hours on this once.

## IPC contract drift

Run `pnpm ipc:check` after editing any contract type. Renderer will lie about preload until you do.

#tech/electron
