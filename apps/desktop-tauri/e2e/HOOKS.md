# Electron test hooks and their e2e commands

The Electron e2e suite reaches the main process through `electronApp.evaluate` and the
`globalThis.__memryTestHooks` object (`apps/desktop/src/main/test-hooks.ts`, plus
`sync/sync-test-hooks.ts`). The Tauri app has no main-process eval. Every hook becomes a plain
`#[tauri::command]` named `e2e_<verb>_<noun>`, registered in `src-tauri/src/e2e/<domain>.rs` and
in `src-tauri/src/e2e/commands.rs`, and called from a spec with
`invokeTest(app, 'e2e_...', args)` (`harness/invoke-test.ts`). Each command answers
`e2e_disabled` unless the app runs with `MEMRY_E2E=1`, and a release build has none of them.
A command that ends the page or the app (`e2e_kill_page`, `e2e_request_quit`,
`e2e_trigger_crash`) can end before its reply reaches the driver, so a spec calls it with
`sendTest(app, 'e2e_...')`, which does not wait for the reply, and `invokeTest` rejects it.

`node e2e/scripts/check-test-hooks-mapped.mjs` fails when a hook of the Electron files is missing
from the first column of the table below. It runs in CI until Step 43 (#3560) deletes the
Electron suite.

## Hooks

| Hook                                        | Command                                   | Added by        |
| ------------------------------------------- | ----------------------------------------- | --------------- |
| `bootstrapSyncDevice`                       | `e2e_bootstrap_sync_device`               | Step 17 (#3534) |
| `setNetworkOnlineForTests`                  | `e2e_set_network_online`                  | Step 17 (#3534) |
| `resetVaultDirectoryThrottle`               | `e2e_reset_vault_directory_throttle`      | Step 17 (#3534) |
| `getCrdtPendingCount`                       | `e2e_crdt_pending_count`                  | Step 14 (#3531) |
| `seedCalendarProjection`                    | `e2e_seed_calendar_projection`            | Step 29 (#3546) |
| `getCrdtDocMarkdown`                        | `e2e_crdt_doc_markdown`                   | Step 14 (#3531) |
| `hasNoteOnDevice`                           | `e2e_has_note_on_device`                  | Step 14 (#3531) |
| `getWritebackDebugState`                    | `e2e_writeback_debug_state`               | Step 14 (#3531) |
| `getCrdtMarkdownSourceState`                | `e2e_crdt_markdown_source_state`          | Step 14 (#3531) |
| `simulateCrdtTeardownForTests`              | `e2e_simulate_crdt_teardown`              | Step 14 (#3531) |
| `seedGoogleCalendarTokens`                  | `e2e_seed_google_calendar_tokens`         | Step 29 (#3546) |
| `getGooglePushChannelProbe`                 | `e2e_google_push_channel_probe`           | Step 29 (#3546) |
| `connectGoogleCalendarForE2E`               | `e2e_connect_google_calendar`             | Step 29 (#3546) |
| `syncGoogleCalendarSourceForE2E`            | `e2e_sync_google_calendar_source`         | Step 29 (#3546) |
| `listCalendarExternalEventsForE2E`          | `e2e_list_calendar_external_events`       | Step 29 (#3546) |
| `createGoogleCalendarEventForE2E`           | `e2e_create_google_calendar_event`        | Step 29 (#3546) |
| `deleteGoogleCalendarEventForE2E`           | `e2e_delete_google_calendar_event`        | Step 29 (#3546) |
| `createMemryEventForWriteBackE2E`           | `e2e_create_memry_event_for_writeback`    | Step 29 (#3546) |
| `pushMemryEventToGoogleForE2E`              | `e2e_push_memry_event_to_google`          | Step 29 (#3546) |
| `fetchGoogleEventForE2E`                    | `e2e_fetch_google_event`                  | Step 29 (#3546) |
| `translateInMain`                           | `e2e_translate_in_main`                   | Step 09 (#3526) |
| `createSecondaryWindowForE2E`               | `e2e_create_secondary_window`             | Step 10 (#3527) |
| `seedInboxItemForE2E`                       | `e2e_seed_inbox_item`                     | Step 27 (#3544) |
| `setInboxReviewSettingsForE2E`              | `e2e_set_inbox_review_settings`           | Step 27 (#3544) |
| `forceInboxReviewTickForE2E`                | `e2e_force_inbox_review_tick`             | Step 27 (#3544) |
| `deleteAllTaskProjectsForE2E`               | `e2e_delete_all_task_projects`            | Step 21 (#3538) |
| `triggerQuickCaptureShortcutForE2E`         | `e2e_trigger_quick_capture_shortcut`      | Step 11 (#3528) |
| `getQuickCaptureShortcutRegistrationForE2E` | `e2e_quick_capture_shortcut_registration` | Step 11 (#3528) |
| `disconnectSyncSocketForTests`              | `e2e_disconnect_sync_socket`              | Step 17 (#3534) |
| `getSyncStateValueForTests`                 | `e2e_sync_state_value`                    | Step 17 (#3534) |
| `pauseSyncForTests`                         | `e2e_pause_sync`                          | Step 17 (#3534) |
| `pushQueuedSyncRowsForTests`                | `e2e_push_queued_sync_rows`               | Step 17 (#3534) |
| `startSyncWakeProbeForTests`                | `e2e_start_sync_wake_probe`               | Step 17 (#3534) |
| `getSyncSocketStateForTests`                | `e2e_sync_socket_state`                   | Step 17 (#3534) |
| `disableCrdtBodyPullsForTests`              | `e2e_disable_crdt_body_pulls`             | Step 14 (#3531) |
| `rateLimitCrdtBodyPullsForTests`            | `e2e_rate_limit_crdt_body_pulls`          | Step 14 (#3531) |
| `getCrdtBodyDebtsForTests`                  | `e2e_crdt_body_debts`                     | Step 14 (#3531) |
| `pullSyncForTests`                          | `e2e_pull_sync`                           | Step 17 (#3534) |
| `getSyncWakeProbeForTests`                  | `e2e_sync_wake_probe`                     | Step 17 (#3534) |
| `listCrdtStoreDirsForTests`                 | `e2e_list_crdt_store_dirs`                | Step 14 (#3531) |
| `restartSyncRuntimeForTests`                | `e2e_restart_sync_runtime`                | Step 17 (#3534) |

## Debug handles

| Electron                                                 | Command                                       | Added by                 |
| -------------------------------------------------------- | --------------------------------------------- | ------------------------ |
| `__memryDebug.query`                                     | `e2e_debug_query`, read-only connection       | Step 08 (#3525), shipped |
| `__memryDebug.indexQuery`                                | `e2e_debug_index_query`, read-only connection | Step 08 (#3525), shipped |
| `__memryDebug.store`                                     | `e2e_debug_store`, read-only                  | Step 08 (#3525)          |
| `__memryDebug.syncEngine`                                | `e2e_sync_engine_state`                       | Step 17 (#3534)          |
| `__memryDebug.crdt`                                      | `e2e_crdt_state`                              | Step 14 (#3531)          |
| `__memryNextContextMenuSelection` (`index.ts:1586-1596`) | `e2e_set_next_context_menu_selection`         | Step 10 (#3527)          |

## Environment switches

| Switch                                                                     | In the Tauri app                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MEMRY_TEST_FORCE_STARTUP_THROW`                                           | Read through `LaunchEnv` only while `E2eGate` is open, and honored by the startup-error path of Step 10 (#3527).                                                                                                                                                                                                                                                                                 |
| `MEMRY_TEST_CRDT_PREFLIGHT_CRASH`                                          | Retired. The Tauri app has no preflight child; `specs/vault/recovery-*.e2e.ts` cover the damaged-database case. `specs/editor/core-readonly-window.e2e.ts` covers the degraded store: it write-protects `data.db` between launches, which SQLite opens read-only, so it needs no switch.                                                                                                         |
| `MEMRY_TEST_DIALOG_RESULT`                                                 | Initial dialog queue; see Dialogs. Passed through the control file `extraEnv`.                                                                                                                                                                                                                                                                                                                   |
| `MEMRY_DEVICE`, `TEST_VAULT_PATH`, `SYNC_SERVER_URL`, `MEMRY_TEST_LOG_DIR` | Written by `fresh()` into the control file; see below. The app opens `currentVault` of `<appDataDir>/memry-config.json`, which `fresh()` seeds with `testVaultPath` (`harness/seed-registry.mjs`).                                                                                                                                                                                               |
| `MEMRY_FORCE_VAULT_PICKER`                                                 | `1` starts on the picker whatever `currentVault` says; `test.use({ extraEnv: { MEMRY_FORCE_VAULT_PICKER: '1' } })`.                                                                                                                                                                                                                                                                              |
| `MEMRY_TEST_UPDATER`                                                       | `scripted` replaces the update backend with the scripted one (`memry_desktop::updater::scripted`), read through `LaunchEnv` while `E2eGate` is open. `e2e_updater_script` queues what the next checks find, and `e2e_updater_hook_calls` lists every install hand-off, which also lands in `<appDataDir>/e2e-updater-applies.jsonl`. Replaces the Electron specs' `updater:state-changed` sends. |
| `MEMRY_TEST_UPDATER_VERSION`                                               | With `MEMRY_TEST_UPDATER=scripted`, the raw version (`YYYY.MDD.N`) the updater reports instead of the bundle's `0.0.0`, so a spec can relaunch as the build an install put in place.                                                                                                                                                                                                             |

## Dialogs

Native dialogs, the color picker and native menus cannot be clicked through WebDriver, so a spec
never opens one. The Rust dialog wrapper (`src-tauri/src/shell/dialogs.rs`, over
`tauri-plugin-dialog`) asks a result queue first when the gate is open
(`memry_desktop::e2e::dialog_queue`):

- The queue holds one answer per dialog kind (`OpenFile`, `OpenFolder`, `SaveFile`, `Confirm`,
  `Choose`), consumed in push order.
- An empty answer means the user cancelled. A `Confirm` answer is the string `confirm` or
  `cancel`. A `Choose` answer (a message with three buttons, such as the Obsidian vault prompt
  of `vault_select`) is the index of the button, `0`, `1` or `2`; the last is the cancel. A
  dialog asked with nothing queued answers as a cancel and logs a warning, so a forgotten push
  fails the spec and never waits on a real dialog.
- `invokeTest(app, 'e2e_dialog_queue_push', { kind, paths })` queues an answer and
  `e2e_dialog_queue_clear` drops them all.
- `MEMRY_TEST_DIALOG_RESULT` (through the control file `extraEnv`) gives the queue at start:
  the plain word `confirm` or `cancel` answers every `Confirm` of the run, and a JSON list of
  `{ "kind": "OpenFolder", "paths": ["/tmp/x"] }` objects is queued in order.
- With an open gate `vault_reveal` and `vault_activity_reveal` record the path instead of
  opening a file manager; `e2e_revealed_paths` reads it back.

## Spelling

`specs/shell/spellcheck.e2e.ts` uses two commands (`src-tauri/src/e2e/shell_integrations.rs`):

- `e2e_spell_ready` answers `true` once the spell checker has loaded its dictionary, `false`
  while it loads, and `null` when the machine has none; it builds the checker if startup has not
  yet. The Windows checker loads in the background after startup, and a call made during the
  load can give up after five seconds, so a spec polls this before its first spelling call.
- `e2e_forget_spelled_word` takes an added word back out of the macOS dictionary; elsewhere it
  does nothing, and the spec adds a fresh word per attempt.

## Vault write-back

The app makes every markdown file outside the journal folder a note (Step 13d, #3530). Until
Step 14 (#3531) edits notes, these commands drive the write-back
(`src-tauri/src/e2e/vault_writeback.rs`, over `memry_desktop::e2e::vault`).
`specs/vault/writeback.e2e.ts`, `identity.e2e.ts`, `vault-files.e2e.ts`,
`vault-markdown-fidelity.e2e.ts` and the soak (`e2e/soak/writeback-soak.ts`, on the VM through
`writeback-soak-vm.ts`) use them:

- `e2e_vault_note_files` lists the rows: `{ noteId, path, contentHash }`. A row with a hash
  has its file's text in the note.
- `e2e_note_edit` retypes a note's first block, then schedules its write-back. It edits
  through `NotesWriter::edit_block`, the iOS path; Step 14 moves it to the desktop editor's
  `Editor::apply_update`. `e2e_note_schedule` schedules notes without editing them, as the sync
  driver does after a pulled page (Step 17). `e2e_note_body` reads a body, one line per block.
- `e2e_vault_write_outside` writes a file as another program does, unseen by the own-write
  record; `replace: true` saves through a side file and a rename. `e2e_vault_read_file`
  returns `{ text, contentHash, mtimeMs, size }` or null. Both take a path inside the vault, so a driver on
  another machine needs no file access.
- `e2e_app_terminate` sends `[NSApp terminate:]`, what Cmd-Q and the Dock's Quit send (macOS
  only). `e2e_request_quit` and `e2e_send_session_end` cover the other ways to quit.
  `e2e_quit_on_page_start` quits the moment the main window's next document commits, before its
  scripts run, so a spec can quit while the page loads.
  `e2e_flush_after_browser_exit` (Windows) ends the WebView2 browser process, asks its page to
  flush with the main thread held, so WebView2 cannot report the death first, then quits.

## Editor windows

`e2e_create_secondary_window` (`src-tauri/src/e2e/window.rs`) opens a second app window on the
app's page and answers its label, `e2e-<n>`, which is also its WebDriver window handle. The e2e
config (`tauri.e2e.conf.json`) gives `e2e-*` windows the main window's permissions and the
driver's. `specs/editor/two-window-typing.e2e.ts` types in one window and reads the other.

## Clipboard

`e2e_clipboard_read` and `e2e_clipboard_write` read and write the OS clipboard's text
(`src-tauri/src/e2e/clipboard.rs`). `e2e_webview_paste` pastes into the main window's focused
element through the webview's own paste command (`paste:` on WKWebView, the `Paste` editing
command on WebKitGTK, CDP `Input.dispatchKeyEvent` with `commands: ["paste"]` on WebView2),
because a WebDriver key is synthetic and pastes nothing. `e2e_webkitgtk_version` answers the
linked WebKitGTK version on Linux and `null` elsewhere. `specs/editor/clipboard-blocks.e2e.ts`
copies blocks from the block menu and pastes them back. `e2e_clipboard_read_image` answers the
`[width, height]` of the clipboard's image, `null` when it holds none;
`specs/editor/clipboard-image.e2e.ts` checks the mind map's Copy as image with it, through the
webview and through `clipboard_write_image`.

## Control file

Each app instance reads `<temp dir>/memry-e2e/control-<port>.json`, keyed by its own
`TAURI_WEBDRIVER_PORT`, before it computes its profile identifier, data dir and log dir:

```json
{
  "appDataDir": "...",
  "logDir": "...",
  "device": "e2e-<uuid>-A",
  "testVaultPath": null,
  "syncServerUrl": null,
  "extraEnv": {}
}
```

Without a file the instance runs in `<temp dir>/memry-e2e/default-<port>` as device
`e2e-default-<port>`, so an e2e build never touches the real app data or keychain accounts.

## Porting a spec

| Playwright                                       | Tauri harness                                       |
| ------------------------------------------------ | --------------------------------------------------- |
| `import { test, expect } from '../fixtures'`     | `import { test, expect } from '../../harness/test'` |
| `electronApp`                                    | `app` (`TauriApp`)                                  |
| `electronAppA`, `electronAppB`                   | `app`, `appB` (multiremote config)                  |
| `pageA`, `pageB`                                 | `page`, `pageB`                                     |
| `vaultPathA`, `vaultPathB`                       | `testVaultPath`, `vaultPathB`                       |
| `electronApp.evaluate(...)`                      | `invokeTest(app, 'e2e_...')`                        |
| `launchElectronWithWindow`, `destroyElectronApp` | `fresh`, `dispose`                                  |
| relaunch                                         | `restart(app)`                                      |
| `waitForMainLog`                                 | `waitForMainLog` (`harness/wait.ts`)                |
| `webContents.send`                               | `e2e_emit(event, payload)`                          |
| `page.addInitScript`                             | runs the function now, then reloads                 |

Mouse input is the W3C Actions endpoint. The macOS WKWebView driver dispatches synthetic
`mousemove`, `mousedown`, `mouseup` and `click` events only, so `pw-compat` adds the pointer
events, focus change, `mouseover`, `dblclick` and `contextmenu` that a real click produces when
the driver did not. `pointerdown` and `pointerup` go just ahead of the driver's `mousedown` and
`mouseup`, on the same target, so a click that reshapes the page (a popover that shrinks) never
sends its press to what ends up under the point. Drag and drop and text selection by mouse need a driver with native input.
