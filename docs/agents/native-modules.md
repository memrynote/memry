# Native Modules

- Node-side tests or scripts failing to load `better-sqlite3` / `classic-level` / `keytar`: `pnpm --filter @memry/desktop rebuild:node`.
- Electron dev/E2E/build native load errors: `pnpm --filter @memry/desktop rebuild:electron`.
- Do not use the Node rebuild as proof for Electron runtime, or the Electron rebuild as proof for Node tests.
- The macOS Calendar bridge (`apps/desktop/native/eventkit`) is a Swift helper executable, not a Node/Electron module: `rebuild:node` / `rebuild:electron` never touch it. On macOS, `predev` builds it (`pnpm --filter @memry/desktop build:eventkit`, needs Xcode command line tools); elsewhere the script is a no-op. Without it, This Mac reports "unavailable" and nothing else changes.
- Fresh worktrees may spend a long quiet period rebuilding Electron native deps; do not call that a hang without evidence. `pnpm install` kicks the rebuild off detached (`scripts/warm-native.mjs`). Watch it with `pnpm warm:log`, run it foreground with `pnpm warm`. `SKIP_ELECTRON_REBUILD=1` (CI) skips it.
