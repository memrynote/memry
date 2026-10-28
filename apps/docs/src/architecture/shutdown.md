# Quit and Shutdown

How MemryNote ends a session without losing an edit, and what it leaves behind when a quit goes wrong. This page covers the Tauri app (`apps/desktop-tauri`).

## The problem

You type in a note and press Cmd+Q a moment later. The text sits in the editor, then in the main process's CRDT document, and only after a short delay in the Markdown file. Quitting at once must still push it through all three. A quit also has to end: if one step hangs, the app cannot stay open forever.

## One sequence, one budget

Every way to quit runs the same ordered sequence under one shared budget of 8 seconds. Each step receives a deadline and clamps its own waits to it, so no set of waits can add up past the budget. The steps run in this order, durable work first:

| Step                     | What it does                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `flush-windows`          | Asks every window to write its unsaved edits, and waits up to 2 seconds for the answer |
| `flush-writebacks`       | Writes pending CRDT changes to the Markdown files                                      |
| `flush-activity-log`     | Writes the buffered activity entries                                                   |
| `close-snapshots`        | Saves a snapshot of each open note                                                     |
| `stop-schedulers`        | Stops reminders, review and calendar runners                                           |
| `stop-capture-server`    | Stops the local capture server                                                         |
| `stop-chat-server`       | Stops the inline chat server                                                           |
| `stop-utility-processes` | Stops voice, image and embedding helpers                                               |
| `stop-sync-runtime`      | Pushes a last snapshot (at most 2 seconds) and stops sync                              |
| `close-vault`            | Closes the vault and its databases                                                     |
| `flush-telemetry`        | Sends queued telemetry for at most 1 second                                            |

A step that nobody registered is skipped. The names are a contract: they become the crash-marker step and the telemetry code `SHUTDOWN_TIMEOUT_<STEP>`. The code is in `crates/memry-desktop/src/shell/shutdown/`.

## What starts it

- Cmd+Q, Dock Quit and logout on macOS. tao cannot refuse a macOS terminate request, so the app adds `applicationShouldTerminate:` to its app delegate. It cancels the termination and runs the app's own exit.
- Closing the last window on Windows and Linux.
- `SIGINT` and `SIGTERM`.
- A request from the app itself, which calls the same exit.

On macOS, closing the last window keeps the app running. Clicking the Dock icon then builds the window again.

## When a step hangs

1. The step that is running when the 8 seconds end is written into `session-marker.json` as `shutdownStep`, with `shutdownFailure: timeout`.
2. The app flushes pending write-backs and the activity log once more, for at most 1.5 seconds, and closes the vault if the hung step ran before it.
3. The process exits with failure code 1.

A timer on a plain thread, outside the async runtime, does the same at 10 seconds, so a wedged runtime cannot keep the app open. On the next launch the marker is reported as `app_crashed` with `SHUTDOWN_TIMEOUT_<STEP>`. A clean quit deletes the marker.

If an update is waiting to install, the exit hands over to the installer instead, so a failed cleanup does not drop the update.

## Closing a window

Closing the main window does not destroy it at once. The app asks the page to flush, runs the registered close hooks, then destroys the window. If the page does not answer in 2 seconds the window still closes, and the failure is logged and reported as `window_close_flush_failed`.

## Crash and failure guards

These run from the first moment of the launch and leave evidence for the next one.

- **Minidumps.** The app starts a copy of itself with `--crash-monitor`. If the app crashes natively, that second process writes a minidump to `crash-dumps/` in the app data folder. The crashed process cannot be trusted to write its own memory. A dump is raw process memory, so it never uploads: only the diagnostic bundle you choose to send reads it. Startup keeps the newest 20 dumps and deletes those older than 30 days.
- **GPU fallback.** On Windows and Linux, a GPU process that crashed, ended unexpectedly or failed to start (or a window that never painted within 10 seconds) writes `gpu-crash-guard.json` with the app version. The next launch of the same version renders in software: `--disable-gpu` on Windows, and `WEBKIT_DISABLE_COMPOSITING_MODE` and `WEBKIT_DISABLE_DMABUF_RENDERER` on Linux. An update retries hardware rendering. macOS has no such switch.
- **Stall monitor.** A watchdog thread asks the main thread to answer every second. If it has not answered for 3 seconds, the log gets one `main thread stalled` line with the launch phase it interrupted. At most 20 lines are written, and none while the system sleeps.
- **Webview process failures.** A webview process that ends is reported as a telemetry log event with the reason, never the page.

## Sign-out, restart and power off

The operating system gives an app a short, system-specific window at the end of a session. The same quit sequence runs in all three, started by the system's own signal:

- **macOS** starts it when `NSWorkspace` announces power off, sign-out or restart.
- **Windows** has two messages. `WM_QUERYENDSESSION` turns install-on-quit off, so an update does not start installing as the machine goes down, and sets a shutdown block reason ("MemryNote is saving your notes") so Windows waits for the app. `WM_ENDSESSION` then runs the sequence and holds the message for up to 4 seconds while the main thread keeps handling messages, because a step may need it. Windows sends the message to every top-level window of the process, and the framework's hidden event-target window would end the process at once, so the app takes the message on that window too and the first window asked does the waiting.
- **Linux** takes a logind delay inhibitor when it starts and runs the sequence on `PrepareForShutdown(true)`; the process exit releases the lock and lets the machine go on, within logind's limit (5 seconds by default). A machine with no system bus goes without these events.

Sleep and wake only log and pause the stall monitor.

## Tray, single instance, deep links and notifications

The Tauri shell (`apps/desktop-tauri/src-tauri/src/`) owns these OS hooks; the pure rules are in `memry_desktop::shell`.

- **Tray (`tray.rs`).** `general.minimizeToTray` creates the icon and hides the main window on close. `apply` runs on the main thread, because dropping a status item elsewhere traps in AppKit. Without a tray host (headless Linux) the close behaves normally. The close handler runs before the shutdown flush handler and skips it for a hide.
- **Single instance (`instance.rs`).** The plugin is registered first. A second launch forwards its arguments to the deep-link plugin and shows the window. The e2e gate turns it off.
- **Deep links (`deep_link/`).** `memry://` is parsed by `shell::deep_link`. A link that arrives before the first paint is queued and delivered after it. The telemetry event carries a coarse target, never the URL.
- **Notifications (`notifications/`).** One path. The click handler is registered at boot; each shown notification has an id that maps to a route. The page may request only `Focus` or a registered handler.
- **Badge (`badge.rs`).** Dock and launcher count; Windows has none, as in Electron.
- **AppUserModelID.** A non-Velopack Windows layout sets `com.memrynote.memry` at process start.
