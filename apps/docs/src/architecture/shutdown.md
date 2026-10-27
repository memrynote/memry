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
