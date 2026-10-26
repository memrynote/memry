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

The backend is not ported yet, so a call to `window.api` rejects with `NotPortedError`. The renderer shows its error state until a domain step ports the call.

## Build it

```bash
pnpm build:tauri
```

This builds a debug binary without a bundle at `crates/target/debug/` (`MemryNote` on macOS, `Memrynote.exe` on Windows, `memrynote` on Linux: the platform overlays set `mainBinaryName`). CI builds it on macOS (arm64 and x64), Windows (x64 and arm64) and Linux x64, launches it and uploads it.

## Logs

The log file is `main.log` in the profile's log directory: `~/Library/Logs/com.memrynote.memry` on macOS, `%LOCALAPPDATA%\com.memrynote.memry\logs` on Windows and `~/.local/share/com.memrynote.memry/logs` on Linux. A device profile adds `.<device>` to that name. The first line reads `MemryNote <version> starting (dev)` or `(packaged)`. Set `MEMRY_TEST_LOG_DIR` and `MEMRY_APP_DATA_DIR` to put the log and data somewhere else, for a test run.

Each line reads `YYYY-MM-DD HH:MM:SS.mmm [level] [scope] text` in local time. `main.log` rotates at 5 MiB: `main.1.log` is the newest archive and `main.4.log` the oldest, so at most five files exist. A line identical to the one before it is counted and written once as `Previous line repeated N more times, the last at this time`. Packaged builds write `info` to the file and `warn` to the console; debug builds write `debug` and `info`, and `RUST_LOG` replaces the file level. A panic is logged at `error` with its backtrace. The launch timeline is one `launch timeline {` block with a `key: value,` line per phase (`scripts/launch-bench.mjs` parses it), logged at `warn` when the window took 5 seconds or more to show.

## Redaction vectors

`memry_desktop::redact` ports `packages/contracts/src/redact.ts` and must match it byte for byte. `packages/contracts/test-vectors/redact.json` and `safe-dimension.json` are generated from the TypeScript functions (`pnpm --filter @memry/contracts exec tsx scripts/gen-protocol-vectors.ts redact`) and `cargo test -p memry-desktop --test redact_vectors` compares every case. Change a pattern in one language and regenerate, or the test fails.

## Add a command

A command is a Rust function that the renderer calls with a generated, typed function.

1. Write the function in `apps/desktop-tauri/src-tauri/src/commands/<domain>.rs` with `#[tauri::command]` and `#[specta::specta]`. Name it `<domain>_<verb>` and return `Result<T, CommandError>`.
2. Add its path to `src-tauri/src/registry.rs` under the domain's comment.
3. Run `pnpm ipc:generate`. It rewrites `src/generated/bindings.ts`. `pnpm ipc:check` fails in CI when you forget.
4. Call `commands.<domainVerb>()` from the renderer. A failure throws the `CommandError`, and `extractErrorMessage` shows its message.

Raw bytes use the helpers in `src/binary.rs` and `lib/ipc-binary.ts` instead.

## Vaults and storage

The app opens a vault through one owner, `memry_desktop::session::Session`. The registry of known vaults is `memry-config.json` in the app data directory, the same file shape Electron wrote, so the migration copies it as it is.

Each vault keeps its databases in `<vault>/.memry/core/`: `data.db` (notes, tasks, sync state) and `index.db` (search, a cache that can be rebuilt). The Electron files in `<vault>/.memry/` are never opened. If `data.db` is an Electron database, the open fails with `foreign_schema` and does not touch the file.

Every database has one writer and a pool of four read-only connections, so a list or a note read does not wait behind a sync write. A method that only runs `SELECT` uses `Db::read`. A method that writes, or reads and then writes in one step, uses `Db::call`. A reader refuses writes, so a misrouted write fails loudly.

If `data.db` is damaged, the open stops with `storage_corrupt`. The app asks once per session: **Repair** keeps the damaged file as `data.db.corrupt-<timestamp>`, builds a fresh database and copies back every table it can read. **Not now** leaves the file alone and shows the picker. Nothing moves before the user answers. `index.db` is rebuilt without asking, because it is derived.

The renderer calls `vault_list`, `vault_select`, `vault_create`, `vault_switch`, `vault_close`, `vault_remove`, `vault_set_default`, `vault_set_icon` and `vault_reveal`, and listens to `VaultStatusChangedEvent`, `VaultErrorEvent`, `VaultListChangedEvent` and `VaultIndexRecoveredEvent`. Events before a listener attaches are not replayed, so read `vault_get_status` once after you subscribe. `MEMRY_FORCE_VAULT_PICKER=1` starts on the picker.

To look at a running e2e build's data, start it with `node apps/desktop-tauri/scripts/agent-app.mjs start`, then run `agent-app.mjs query "SELECT count(*) AS n FROM sync_items"` (or `index-query` for `index.db`). Only one read statement is accepted.

## Two renderers

Until the cutover deletes the Electron app, `apps/desktop-tauri/src/renderer` is a copy of `apps/desktop/src/renderer`. A critical renderer fix lands in both in the same PR. The rest of the rules are in `apps/desktop-tauri/AGENTS.md`.

## Native strings

The Tauri process speaks the `errors`, `menu`, `system` and `notes` namespaces of `packages/i18n/src/locales`; `crates/memry-desktop/build.rs` embeds them for all 32 locales and `memry_desktop::i18n::t(locale, "ns:dotted.key", &args)` looks a key up (the locale, then English; a missing key comes back as `ns:key`). The formatter is a port of the `intl-messageformat` subset the messages use: arguments, `plural` with `#`, `select` and apostrophe quoting, with plural rules and number digits from ICU4X. `crates/memry-desktop/tests/vectors/i18n-format.json.gz` holds what the real main-process i18n produces for every message and `cargo test -p memry-desktop --test i18n_vectors` replays it. After you edit a locale file or the formatter, run `pnpm --filter @memry/i18n vectors:generate`; CI runs `vectors:check`.
