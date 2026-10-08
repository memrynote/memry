# CLI guide

This directory owns `@memry/cli`, the `memrynote` command-line client for a user's vault. It runs two ways. `bin/memrynote.mjs` runs `src/index.ts` under Node's type stripping, and the desktop app bundles `src/run.ts` and runs it for `--cli` arguments (`apps/desktop/src/main/cli/headless.ts`). A CLI change ships inside the next desktop release.

## Layout

- `src/run.ts` parses and dispatches commands. `src/app-core/memry-app.ts` composes the services they call, from `src/app-core/` and from `packages/app-core`, which desktop shares.
- `src/app-core/paths.ts` and `src/app-core/locale.ts` own vault path and locale resolution. Use them instead of deriving paths inline.
- `src/app-core/database.ts` opens the vault's databases and runs desktop's migrations from `apps/desktop/src/main/database/`, so [desktop's migration rules](../desktop/AGENTS.md#databases) apply here too.

## Parity with desktop

`src/app-core` mirrors desktop behavior, and it drifts when a desktop feature changes shape. `src/app-core/scope-parity.test.ts` holds the CLI to desktop's behavior on shared operations. Read it before adding a command, and extend it when a desktop change reaches a command.

## Behavior

- The CLI writes to a real user vault. Every destructive operation needs an explicit flag or confirmation.
- Exit non-zero on failure. Results go to stdout and errors to stderr, so piped output stays machine-readable.
- Prompt only when stdin is a TTY. A code path that can run non-interactively never waits for input.
- Read commands never rewrite vault files.

## Compatibility

- Command names, flags, and output shape are a contract once shipped. Adding is fine. Renaming or removing one needs Kaan's request.
- The CLI can open a vault last written by an older or newer desktop. Opening runs the bundled migrations, which is safe only because migrations are additive and an older desktop can still open the result.

## Tests

Tests use `node:test` under Node's type stripping, not Vitest, and live next to the code. Run `pnpm --filter @memry/cli test`, or `pnpm test:cli` to include `packages/app-core`. `pnpm --filter @memry/cli typecheck` is the type gate.
