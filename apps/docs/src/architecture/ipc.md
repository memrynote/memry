# IPC Boundary

Renderer ↔ main process communication is type-checked end-to-end via shared contracts.

## Shape

- Contracts live in `packages/contracts` and are Zod-typed.
- The preload script exposes a typed `window.api` surface.
- Main-side handlers register against the same contract types.

## Invoke Map

`pnpm ipc:generate` regenerates the invoke map from contracts. `pnpm ipc:check` validates the boundary at typecheck time.

## When to Run These

- After adding or renaming an IPC channel
- After changing a request / response Zod schema
- Before opening a PR that touches the renderer / main boundary

## Error Propagation

Renderer-side errors from IPC use `extractErrorMessage(err, fallback)` from `@/lib/ipc-error` to strip Electron noise before display.

## Logging

Both sides use `createLogger(scope)` from electron-log; never `console.*`.
