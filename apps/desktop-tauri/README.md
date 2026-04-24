# @memry/desktop-tauri

Tauri 2.x rewrite of the Memry desktop app. See
`docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
for the full migration design.

## Development

```bash
pnpm install              # from repo root
pnpm --filter @memry/desktop-tauri dev
```

Vite dev server on http://localhost:1420; Tauri window attaches automatically.

## Build

```bash
pnpm --filter @memry/desktop-tauri build
```

Produces unsigned `.app` under `src-tauri/target/release/bundle/macos/`.

## Status

- **M1 (current):** Skeleton + full renderer port with mock IPC layer. Visual
  parity with Electron achieved; no real backend logic yet.
