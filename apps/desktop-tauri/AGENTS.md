# Tauri desktop guide

This directory owns the Tauri v2 desktop app (`@memry/desktop-tauri`), the app that replaces the Electron app in `apps/desktop` at the cutover. [docs/adr/0001-desktop-on-tauri-v2.md](../../docs/adr/0001-desktop-on-tauri-v2.md) records the decision, and the epic is #3517. Read [crates/AGENTS.md](../../crates/AGENTS.md) before changing Rust.

## Ownership

- `src/renderer` is a copy of the Electron renderer. It reaches Rust through the generated `src/generated/bindings.ts` (`commands.*`) and the helpers in `src/renderer/src/lib/ipc-binary.ts`. Until a domain step ports a call, `window.api` is the not-ported shim (below).
- `src-tauri` is the `memry-tauri` bin crate, the Tauri adapters only. A command parses its arguments, calls one service method and maps the error. Domain decisions live in `crates/memry-core` and `crates/memry-desktop`.
- `crates/memry-desktop` owns launch environment (`LaunchEnv`), app paths, logging, the HTTP client and the command failure throttle. It never depends on `tauri`. `LaunchEnv` is the only reader of the process environment for launch switches; nothing else calls `std::env::var` for one.
- `src/preload/index.d.ts` is a type-only copy of the Electron preload declaration, so the copied renderer's relative type imports resolve. A domain step deletes the types it replaces, and the cutover step deletes the file.

## Dual renderer rule

Until the cutover step deletes `apps/desktop`, a renderer change that fixes a critical bug lands in both `apps/desktop/src/renderer` and `apps/desktop-tauri/src/renderer` in the same PR, and the PR body names both paths. The Tauri copy differs from the Electron one only in `index.html`, `main.tsx`, `env.d.ts`, `lib/logger.ts`, `lib/startup-theme.ts`, `lib/startup-locale.ts`, `lib/ipc-error.ts`, `lib/ipc-binary.ts`, `lib/not-ported.ts` and `lib/startup/`. Check with `diff -r apps/desktop/src/renderer apps/desktop-tauri/src/renderer`.

## Commands

- Name a command `<domain>_<verb>` in snake_case. Its module lives in `src-tauri/src/commands/<domain>.rs`, and its path goes in `src-tauri/src/registry.rs` under the domain's comment, one fully qualified path per line, domains in alphabetical order.
- Command types derive `Serialize`, `Deserialize` and `specta::Type` with `#[serde(rename_all = "camelCase")]`.
- No 64-bit integer that needs more than 53 bits crosses IPC. Ids and hashes travel as strings. The builder casts `i64` to a JavaScript number because every `i64` that crosses is an epoch-millisecond timestamp, a count or a size.
- A command returns `Result<T, CommandError>`. A rejected call throws the serialized `CommandError { kind, code, message }`, which `extractErrorMessage` reads. Call `log_failure(command, &error)` in the `map_err`. Messages never carry secrets.
- Raw payloads (file bytes, Yjs updates) use the helpers in `src-tauri/src/binary.rs` and `lib/ipc-binary.ts`. Binary commands are plain `#[tauri::command]` functions listed in `binary::COMMANDS`, not specta commands.
- Blocking work runs in `tauri::async_runtime::spawn_blocking`.
- After a change, run `pnpm ipc:generate` and commit `src/generated/bindings.ts`. `pnpm ipc:check` fails with that command when the file is stale. Never edit the file by hand.

## Events

- An event is a struct deriving `tauri_specta::Event`, named `<Domain><Noun><Verb>Event` (`CalendarChangedEvent`, `SyncStatusChangedEvent`). The wire name is the one tauri-specta derives. Legacy channel strings are not used.
- List it in `registry.rs` and emit it after commit with `events::broadcast` or `events::send_to`. Both log a failed delivery and return, so they are safe inside a transaction. Do not call `emit` directly.

## Startup

- `startup::register(stage, name, f)` adds work to a boot stage (`Paths`, `Logging`, `Guards`, ... `Schedulers`). `run()` executes stages in enum order. A failing stage exits with code 2. Do not edit `run()` to add boot work.
- `StartupState` is the one startup type. Rust publishes it as `window.__MEMRY_STARTUP__` through the main window's init script, and `src/renderer/src/lib/startup/` applies it before first paint.

## The not-ported shim

`lib/not-ported.ts` makes `window.api` and `window.electron` proxies that throw `NotPortedError("window.api.<path> is not ported")` on a call. An `onXxx` leaf returns a no-op unsubscribe function. Every script that starts or builds the app sets `VITE_MEMRY_DEV_API_PROXY=1`; release builds do not. Step 43 (#3560) deletes the shim.

## E2E

The `e2e` Cargo feature is declared and empty. Step 03 (#3520) fills it.

## Validation

```bash
pnpm lint && pnpm typecheck && pnpm format:check && git diff --check
pnpm --filter @memry/desktop-tauri test
cd crates && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
cd crates && cargo test -p memry-desktop -p memry-tauri
node scripts/check-line-ceilings.mjs
```

- 800 lines per TypeScript file and 600 per Rust file. Split a file at its ceiling before adding behavior.
- Logs go to `main.log` in the platform log directory of the profile identifier (`com.memrynote.memry`, plus `.<device>` for `MEMRY_DEVICE`). `MEMRY_APP_DATA_DIR` and `MEMRY_TEST_LOG_DIR` replace the data and log directories.
