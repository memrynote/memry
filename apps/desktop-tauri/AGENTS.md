# Tauri desktop guide

This directory owns the Tauri v2 desktop app (`@memry/desktop-tauri`), the app that replaces the Electron app in `apps/desktop` at the cutover. [docs/adr/0001-desktop-on-tauri-v2.md](../../docs/adr/0001-desktop-on-tauri-v2.md) records the decision, and the epic is #3517. Read [crates/AGENTS.md](../../crates/AGENTS.md) before changing Rust.

## Ownership

- `src/renderer` is a copy of the Electron renderer. It reaches Rust through the generated `src/generated/bindings.ts` (`commands.*`) and the helpers in `src/renderer/src/lib/ipc-binary.ts`. Until a domain step ports a call, `window.api` is the not-ported shim (below).
- `src-tauri` is the `memry-tauri` bin crate, the Tauri adapters only. A command parses its arguments, calls one service method and maps the error. Domain decisions live in `crates/memry-core` and `crates/memry-desktop`.
- `crates/memry-desktop` owns launch environment (`LaunchEnv`), app paths, logging, the HTTP client and the command failure throttle. It never depends on `tauri`. `memry-desktop/src/seams/` holds the desktop implementations of the core seams: `secure_store`, `transport`, `tls` and `reachability`. The renderer never requests a memry host: sync, telemetry and feedback go through Tauri commands to the pinned transport, and `node scripts/check-renderer-no-sync-host.mjs` enforces it. The `FileProtection` seam stays unimplemented on desktop: the core has no consumer, and the session passes `<vault>/.memry/core/` to `Vault::open`. `LaunchEnv` is the only reader of the process environment for launch switches; nothing else calls `std::env::var` for one.
- `src/preload/index.d.ts` is a type-only copy of the Electron preload declaration, so the copied renderer's relative type imports resolve. A domain step deletes the types it replaces, and the cutover step deletes the file.

## Dual renderer rule

Until the cutover step deletes `apps/desktop`, a renderer change that fixes a critical bug lands in both `apps/desktop/src/renderer` and `apps/desktop-tauri/src/renderer` in the same PR, and the PR body names both paths. The Tauri copy differs from the Electron one only in `index.html`, `main.tsx`, `env.d.ts`, `lib/logger.ts`, `lib/startup-theme.ts`, `lib/startup-locale.ts`, `lib/ipc-error.ts`, `lib/ipc-binary.ts`, `lib/not-ported.ts`, `lib/startup/`, `services/vault-service.ts`, `pages/settings/vault-section.tsx` and `hooks/use-vault.ts` (its initial load tolerates a failing `getConfig` until Step 09 (#3526) ports it). Check with `diff -r apps/desktop/src/renderer apps/desktop-tauri/src/renderer`.

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

## Dev tools

- The web inspector exists in debug builds only: View > Toggle Developer Tools, F12, and Tauri's Cmd+Opt+I or Ctrl+Shift+I. Release builds compile none of it, so the `tauri` dependency carries no `devtools` feature (Rust CI fails when a crate turns it on) and inspector code sits behind `cfg(debug_assertions)`.
- Cmd/Ctrl+R and F5 reload the page in debug builds only (`windows/scripts/dev-keys.js`). In a release build View > Reload is the only reload.
- React DevTools, which the Electron app loaded as an extension, has no counterpart here. Read component state through the inspector.

## Startup

- `startup::register(stage, name, f)` adds work to a boot stage (`Paths`, `Logging`, `Guards`, ... `Schedulers`). `run()` executes stages in enum order. A failing stage exits with code 2. Do not edit `run()` to add boot work.
- `StartupState` is the one startup type. Rust publishes it as `window.__MEMRY_STARTUP__` through the main window's init script, and `src/renderer/src/lib/startup/` applies it before first paint.

## The not-ported shim

`lib/not-ported.ts` makes `window.api` and `window.electron` proxies whose calls return a promise rejected with `NotPortedError("window.api.<path> is not ported")` (a synchronous throw blanked the window at boot). An `onXxx` leaf returns a no-op unsubscribe function. Every script that starts or builds the app sets `VITE_MEMRY_DEV_API_PROXY=1`; release builds do not. Step 43 (#3560) deletes the shim.

## E2E

WebdriverIO drives a built app. `pnpm build:e2e` builds it (cargo feature `e2e`, `VITE_MEMRY_E2E=1`, `src-tauri/tauri.e2e.conf.json`). `pnpm test:e2e` runs `e2e/specs/**` (one app per worker) and `pnpm test:e2e:multi` runs `e2e/specs/two-device/**` (instances A and B). `MEMRY_E2E_BINARY` overrides the binary path.

- The driver exists only in an `e2e` build and starts only with `MEMRY_E2E=1` (`E2eGate`). A release build links none of it, and `scripts/smoke-launch.mjs --expect-no-driver` proves that.
- Specs import `test` and `expect` from `e2e/harness/test.ts`, a Playwright-shaped layer (`page`, `locator`, `expect`, fixtures) over mocha and WebDriver. A fresh app per test; `restart(app)` relaunches it on the same data.
- Per-instance state travels in `<temp>/memry-e2e/control-<port>.json` (`harness/tauri-lifecycle.ts`, `memry_desktop::e2e::control`). The webview profile is isolated per instance, so two instances need macOS 14 or later.
- No main-process eval, for specs and for `agent-app.mjs eval` (which runs in the renderer only). A spec calls a named `e2e_*` command through `invokeTest(app, name, args)`. A domain step adds its commands under `src-tauri/src/e2e/<domain>.rs` and one line in `e2e/commands.rs`, and updates `e2e/HOOKS.md`. `pnpm check:test-hooks` fails while an Electron hook has no mapped command.
- A native dialog is never opened by a spec. The dialog queue is in `e2e/HOOKS.md` (`e2e_dialog_queue_push`, `MEMRY_TEST_DIALOG_RESULT`). `fresh()` registers `testVaultPath` as the current vault of the app's `memry-config.json` (`harness/seed-registry.mjs`), and `invoke(page, 'vault_*')` in `harness/vault-commands.ts` calls the vault commands as the renderer does.
- Specs never leave keychain items: `e2e-` device ids are purged on completion, `pnpm keychain:purge-e2e` sweeps leaks.

## Live app verification

Verify a change in the running app when it touches what a user sees or does: UI, startup, windows, anything a spec cannot show. A passing test is not that proof. The sandbox never opens a real profile or vault.

1. `pnpm --filter @memry/desktop-tauri build:e2e` after each code change (a build without the `e2e` feature cannot be driven).
2. `node apps/desktop-tauri/scripts/agent-app.mjs start` prints the pid, the WebDriver URL, the vault path and the log path. It copies the test vault into a temp dir and runs as device `e2e-agent-<uuid>`.
3. Drive the app with the `webdriver-memry` MCP server (`.pi/mcp.json`): `browser_snapshot`, `browser_click`, `browser_type`, `browser_take_screenshot`, `browser_evaluate`. `agent-app.mjs eval "<javascript>"` and `shot <file.png>` do the same from a shell. Read a screenshot before you call a visual change done.
4. `node apps/desktop-tauri/scripts/agent-app.mjs stop` removes the temp dirs, the control file and the device's keychain items.

Options for `start`: `MEMRY_AGENT_VAULT_TEMPLATE=<dir>` opens a copy of another vault, `MEMRY_AGENT_FIRST_RUN=1` opens no vault, `MEMRY_AGENT_SCALE=2` renders at 2x on Windows and Linux, `MEMRY_AGENT_BINARY=<path>` replaces the debug build, `TAURI_WEBDRIVER_PORT=<port>` replaces 9222. One instance at a time. `agent-app.mjs query "<sql>"` and `index-query "<sql>"` run one read-only statement against the open vault's `data.db` or `index.db` and print the rows as JSON; a write exits 1 with `read-only`. `start` registers the vault copy as the current vault.

Report what you exercised and what you observed, not that it works.

## Validation

```bash
pnpm lint && pnpm typecheck && pnpm format:check && git diff --check
pnpm --filter @memry/desktop-tauri test
cd crates && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
cd crates && cargo test -p memry-desktop -p memry-tauri
node scripts/check-line-ceilings.mjs
pnpm --filter @memry/desktop-tauri test:scripts && pnpm --filter @memry/desktop-tauri test:e2e:harness
```

- 800 lines per TypeScript file and 600 per Rust file. Split a file at its ceiling before adding behavior.
- Logs go to `main.log` in the platform log directory of the profile identifier (`com.memrynote.memry`, plus `.<device>` for `MEMRY_DEVICE`). `MEMRY_APP_DATA_DIR` and `MEMRY_TEST_LOG_DIR` replace the data and log directories.
