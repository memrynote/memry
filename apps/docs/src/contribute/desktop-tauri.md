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

This builds a debug binary without a bundle at `crates/target/debug/memry-tauri`. CI builds it on macOS (arm64 and x64), Windows (x64 and arm64) and Linux x64, launches it and uploads it.

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

`memry_desktop::telemetry` is the native telemetry client, with the schema and behavior of `apps/desktop/src/main/telemetry`: `telemetry.json` (install id, `enabled`, `autoSendDiagnostics` where only an explicit `false` opts out, diagnostics salt), a crash-durable queue journal (`telemetry-event-queue.json`, format 2, version 1 readable), a `session-marker.json` crash marker, and a sender that ships 50 events per batch through `http::client` (a 4xx other than 429 drops the batch). `Service::track_main_warning` reports an expected failure as an `app_log_recorded` warn, never as an error. `packages/contracts/test-vectors/telemetry-events.json` holds the event names, surfaces, dimension allowlist and sanitizer outputs of `telemetry-api.ts`; `cargo test -p memry-desktop --test telemetry_vectors` pins the Rust lists to it, so add an event name in the contract, run `pnpm --filter @memry/contracts vectors:generate`, then add it to `telemetry::events`.

**Settings.** `memry_desktop::settings::SettingsService` is the shell's one door to a vault's `AppSettings` (core owns the groups, the local and synced split and the clocks). A write also mirrors the portable `general` and `editor` fields into `<vault>/.memry/config.json` `preferences` (`vault_prefs`, read tolerantly, unknown keys kept) and refreshes the startup cache in `memry-config.json` (`startupTheme`, `startupColorTheme`, `zoomFactor`, read only while no vault is open). Opening a vault seeds its settings from stored preferences once, while every portable value is still the default. The commands are generic over the group (`settings_get_group`, `settings_set_group`, `settings_get_local`, `settings_set_local`, `settings_reset_keyboard`); `lib/settings-api.ts` in the renderer gives each old `window.api.settings` function its name back. A write emits `SettingsChangedEvent { key, fields }` (names only) and one `setting_changed` per field. Synced fields need a device identity, so until the OS keychain lands (Step 15, #3532) `profile_store::ProfileDeviceKeyStore` keeps the device signing key, and only that key, in `<profile>/device-key` (mode 0600); Step 15 must move that key, not mint a new one.

**Language.** `locale::resolve_startup` picks the language at launch (the stored one, else the OS language on a first run, then the vault preference), `LocaleService` is the live value native strings use, and `locale_set` switches it, stores it in `memry-config.json`, the vault preferences and `general.language`, and emits `LocaleChangedEvent`. The recovery prompt and the vault picker take their strings from the catalog.

**Runtime configuration.** `build.rs` compiles `SYNC_SERVER_URL`, the Google Calendar and OneNote client ids and the Unsplash key into the binary from the process environment, then `apps/desktop-tauri/.env.<MEMRY_ENV>` (`MEMRY_ENV` defaults to production for a release build and to development otherwise, and an `e2e` build is always development). A production release build without `SYNC_SERVER_URL`, `GOOGLE_CALENDAR_CLIENT_ID` or `GOOGLE_CALENDAR_CLIENT_SECRET` fails and names the variable. `memry_desktop::config::RuntimeConfig` is the one reader: launch switches (`MEMRY_ENV`, `SYNC_SERVER_URL`, `TELEMETRY_ENDPOINT`) override only a non-production build, and nothing else reads `SYNC_SERVER_URL`.

**Logs and reports.** `main.log` rotates at 5 MiB over five files. The `ShipLayer` tracing layer redacts warn and error records, keeps the last 200 lines or five minutes for incident reports, and ships batches to `/telemetry/logs` (never from a development build or while telemetry is off). `diagnostics_preview_report` and `diagnostics_send_report` build and post the user-approved incident report, `feedback_submit` posts feedback, and `log_write` takes renderer records into the same pipeline.

**Renderer wiring.** `lib/ported-api.ts` puts the Step 09 domains on `window.api` (`settings`, `locale`, `telemetry`, `feedback`, `diagnostics`, `onSettingsChanged`, `onSettingsOpenRequested`, `onLocaleChanged`), each over its Rust commands in `services/settings-service.ts` and `services/app-services.ts`, so callers keep the Electron names and shapes. `onSettingsChanged` turns the wire event `{ key, fields }` back into `{ key, value }` by reading the written fields; sidebar fields arrive as `sidebar.<field>` and the callout types as `editor.calloutTypes`, the keys those listeners filter on. A rejected write resolves as `{ success: false, error }`, as the Electron handlers did. The AI, calendar-provider, voice-model, terminal-command and global-shortcut functions stay on the not-ported shim until Steps 22, 29, 24, 35 and 11 port them. `lib/logger.ts` also forwards every record to `log_write`. The e2e specs `specs/settings/settings-persistence.e2e.ts` and `diagnostics-report.e2e.ts` run against a local HTTP stub in place of the sync server.

## Windows

`src-tauri/src/windows/` owns every window. `registry.rs` names the kinds (`main`, `quick-capture`, `sticky`, `sticky-tab`, `pdf-print-<n>`, `preboot`, `startup-error`, `e2e-<n>`); code that needs "the window" calls `WindowRegistry::main_window(app)` and a window-wide event goes through `WindowRegistry::broadcast`, never `webview_windows()`. `events.rs` is the only `on_window_event`: it feeds the bounds persister and the focus tracker, then runs the handlers a step adds with `WindowEvents::on_close_requested`.

The main window is built hidden and `reveal.rs` shows it when the renderer's `ShellLifecycle` component mounts and invokes `shell_first_paint` (a hidden WKWebView runs no animation frames, so the call is a React effect, not `requestAnimationFrame`). A 10 s timer shows it anyway. The page then calls `shell_heartbeat` every 2 s, and the shell logs `main window renderer unresponsive` after three missed beats.

The window opens at 1550x900, or at the size and position saved in `windowBounds` of `memry-config.json` when a display still shows at least 100x50 px of it. The vault picker is 900x720, grows to the saved size when a vault opens and shrinks back when it closes (not during a vault switch). `memry_desktop::shell::bounds` holds the pure rules. Bounds are logical units, written 1.5 s after the last resize or move and on close, only while a vault is open, and every key of the stored object that this build does not know is kept. The size stored is the inner size, which is what the builder applies; Electron stored the outer size, so a Linux window differs by its title bar once, the first time it moves between builds. `app_set_zoom_factor` stores the factor and applies it to every app window.

E2E specs that look at the window size keep the harness from resizing it with `test.use({ keepWindowRect: true })`.

## Window chrome

`windows/chrome.rs` sets the frame per OS: macOS a hidden title bar with the traffic lights at (12, 12) drawn over the title row, Linux the native frame, Windows no frame (`decorations(false)`, shadow on) with WebView2 browser accelerator keys off. Windows draws its caption buttons in React (`components/caption-buttons.tsx`, 46x36 each) and reports their physical-pixel rectangles with `window_set_caption_rects`. `windows/win32_caption.rs` subclasses the top-level window and the WebView2 render child so `WM_NCHITTEST` answers `HTMINBUTTON`, `HTMAXBUTTON` and `HTCLOSE` inside them (Windows 11 shows its snap layouts over maximize); hover and press arrive as `WindowCaptionHoverChangedEvent` and `WindowCaptionPressedChangedEvent` because the page gets no mouse events for those regions. `--caption-reserve-end` is 138px on Windows outside fullscreen (`data-fullscreen` follows `WindowChromeStateChangedEvent`).

Dragging uses `windows/scripts/drag-region.js`, an init script of the main frame only: a capture-phase `mousedown` on `.drag-region` (not on `.no-drag`, links, buttons or inputs) calls `plugin:window|start_dragging`, and a double click calls `toggle_maximize`. `-webkit-app-region` does not exist in these engines, so `.drag-region` and `.no-drag` are plain marker classes. The same script publishes `window.__MEMRY_SHELL__`.

`window_minimize`, `window_toggle_maximize` and `window_close` act on the calling window. Back and forward come from mouse buttons 3 and 4 and the browser keys in the renderer, `WM_APPCOMMAND` on Windows and a local `NSEvent` swipe monitor on macOS, all as `AppNavigationRequestedEvent { direction }`.

## Application menu

`memry_desktop::shell::menu_spec` builds the menu as data from the generated command table (`menu_table.generated.rs`, produced by `pnpm ipc:generate` from `@memry/contracts`). `apps/desktop-tauri/src-tauri/src/menu/` turns it into a muda menu and rebuilds it on a language change, a vault change and a keyboard rebind.

- A command item sends `MenuCommandInvokedEvent`; the renderer runs the command through `useMenuBridge`. Reload, DevTools, links, Back and Forward run in the shell.
- macOS sets live accelerators. Windows and Linux put the shortcut in the label only, so the editor keeps its keys; F1 opens the docs from the shell.
- Linux hides the menu bar until a bare Alt (`menu_toggle_alt`); Windows pops the menu up at the title row.
- `shell_show_context_menu` shows a native context menu and returns the clicked item id. In an e2e build, `e2e_set_next_context_menu_selection` answers it and `e2e_menu_tree` reads the built menu.
