# Desktop on Tauri

The desktop app is moving from Electron to Tauri v2 over the Rust core. The new app lives in `apps/desktop-tauri`. This page shows how to run it, build it and add a command.

## Prerequisites

- Node 24 and pnpm (see the root `package.json`).
- The Rust toolchain pinned in `crates/rust-toolchain.toml`. Entering `crates/` installs it with rustup.
- macOS: Xcode command line tools.
- Windows: the Visual Studio C++ build tools and WebView2, which Windows 11 includes.
- Linux: `libwebkit2gtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev libsecret-1-dev patchelf`.

## Run it

```bash
pnpm install
pnpm dev:tauri
```

The command opens a window titled MemryNote that loads the renderer from the Vite dev server on port 5173. The device profiles `pnpm dev:tauri:a`, `:b` and `:c` run separate profiles side by side, each with its own data and log directory. Plain `pnpm dev:tauri` hashes the checkout path into its profile, so two checkouts do not share state.

The backend is not ported yet, so a call to `window.api` throws `NotPortedError`. The renderer shows its error state until a domain step ports the call.

## Build it

```bash
pnpm build:tauri
```

This builds a debug binary without a bundle at `crates/target/debug/` (`MemryNote` on macOS, `Memrynote.exe` on Windows, `memrynote` on Linux: the platform overlays set `mainBinaryName`). CI builds it on macOS (arm64 and x64), Windows (x64 and arm64) and Linux x64, launches it and uploads it.

## Logs

The log file is `main.log` in the profile's log directory: `~/Library/Logs/com.memrynote.memry` on macOS, `%LOCALAPPDATA%\com.memrynote.memry\logs` on Windows and `~/.local/share/com.memrynote.memry/logs` on Linux. A device profile adds `.<device>` to that name. The first line reads `MemryNote <version> starting (dev)` or `(packaged)`. Set `MEMRY_TEST_LOG_DIR` and `MEMRY_APP_DATA_DIR` to put the log and data somewhere else, for a test run.

## Add a command

A command is a Rust function that the renderer calls with a generated, typed function.

1. Write the function in `apps/desktop-tauri/src-tauri/src/commands/<domain>.rs` with `#[tauri::command]` and `#[specta::specta]`. Name it `<domain>_<verb>` and return `Result<T, CommandError>`.
2. Add its path to `src-tauri/src/registry.rs` under the domain's comment.
3. Run `pnpm ipc:generate`. It rewrites `src/generated/bindings.ts`. `pnpm ipc:check` fails in CI when you forget.
4. Call `commands.<domainVerb>()` from the renderer. A failure throws the `CommandError`, and `extractErrorMessage` shows its message.

Raw bytes use the helpers in `src/binary.rs` and `lib/ipc-binary.ts` instead.

## Two renderers

Until the cutover deletes the Electron app, `apps/desktop-tauri/src/renderer` is a copy of `apps/desktop/src/renderer`. A critical renderer fix lands in both in the same PR. The rest of the rules are in `apps/desktop-tauri/AGENTS.md`.
