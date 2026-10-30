# Vault Files (Tauri)

How the Tauri app (`apps/desktop-tauri`) keeps the Markdown files of a vault and the note documents in step. The code is in `crates/memry-desktop/src/vault/`. The Electron app does the same work in `apps/desktop/src/main/vault/` and `src/main/sync/crdt-writeback.ts`, described in [Local Storage](/architecture/local-storage) and [Markdown Write-Back](/architecture/crdt#markdown-write-back).

## The problem

A note lives twice. Its text is a CRDT document in `.memry/core/data.db`, which the editor and sync change. It is also a Markdown file in the vault folder, which you, another editor, Obsidian or a sync tool can change at any time. Each side must reach the other without losing a word.

For example: you type in a note, and a second later a sync tool replaces its file with an older copy. The app must not write your typing over the file blindly, and it must not take the old copy without keeping what you typed.

## Three parts

| Part       | Module             | What it does                                                                                                    |
| ---------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Watcher    | `vault::watch`     | Turns OS file events into facts: a file was added, changed, removed or renamed                                  |
| Consumer   | `vault::consumer`  | Applies those facts: records each file in the `note_files` table and feeds outside edits to the note's document |
| Write-back | `vault::writeback` | Writes a note's document to its file once the note is quiet                                                     |

`VaultTier` (`vault/consumer/tier.rs`) starts all three when a vault opens and stops them when it closes.

## The watcher

The watcher uses the OS file watcher through the `notify` crate: FSEvents on macOS, `ReadDirectoryChangesW` on Windows and inotify on Linux.

- **What it ignores.** Names that start with a dot, the `attachments` folder at the vault root (a folder named `attachments` deeper down is watched), the exclude patterns of `.memry/config.json`, and file types the app does not open. An unsupported file is reported as such, for the activity log.
- **When it looks.** A path is looked at once it has been quiet for 150 ms, so a file still being written is read once, when it is complete. A path that never goes quiet is read after 5 seconds.
- **What counts as a change.** The watcher hashes the file and compares the hash with the `note_files` row. Saving the same bytes again is not a change. An editor's atomic save (a temp file renamed over the note, or the note moved aside and written again) is one change of the same note.
- **Renames.** A removed note whose bytes show up at another path within 500 ms is a rename, so the note keeps its id. This also works for files moved while the app was closed: the start rescan pairs them.
- **The app's own writes.** The write-back tells the watcher what it is about to write (`EchoGuard`), so the app's own write never comes back as an outside edit.
- **A vault that goes away.** The vault counts as there while `.memry/core/data.db` is a file. When it is not, for example because a drive was unplugged, the watcher reports no removals and checks every 2 seconds. When the vault is back, the watcher starts again and rescans.
- **Many files gone at once.** When a rescan finds more than 20 files missing and more than 25 % of the vault, it reports no removal. This keeps a half-mounted vault from deleting notes on every device.
- **Lost events.** Some OS watchers drop events without saying so. The watcher then rescans: after an overflow, after a burst of events on Windows, every 10 minutes on Windows, and every minute after any watcher error.

Known limitation: on Linux, when the inotify watch limit (`fs.inotify.max_user_watches`) runs out, the folders past the limit are covered only by the once-a-minute rescan. The app logs `the vault watcher failed` with `limit=true`, but it shows no notice yet.

## The consumer

The consumer is the one writer of `note_files`. A row holds the file's path, size and the hash of the text the note's document holds.

When a file changes outside the app, the consumer feeds the new text to the note's document and keeps the body it replaces as a version. The row's hash is recorded only after the document took the whole file. The write-back trusts that hash, so a hash recorded too early would let it write over text the document never had.

## The write-back

**When.** A note's file is written 500 ms after its last edit. Every edit starts the wait again, so typing writes the file once, when you pause. After a write, the next one waits 9 times what that write cost, at most 5 seconds, so a large note does not keep a core busy while you type. Every quit and every vault close writes all waiting notes first (the `flush-writebacks` step of [Quit and Shutdown](/architecture/shutdown)).

**What.** A pass writes the file only when the file still has the bytes the document is known to hold. It keeps the file as it is when:

- the file changed outside the app and the change has not reached the document yet; the consumer feeds it instead;
- the file is ahead of the document, or the note's server body has not been downloaded;
- writing the document would lose content, such as a block a newer build wrote.

A pass that would write the same bytes writes nothing, so the file's modification time does not change. Before a write replaces bytes the app did not write, the old file is kept as a version.

A note whose app is killed before its write still reaches its file: when the vault opens next, the open reconcile writes every note whose document is ahead of its file.

## Shared files

`.memry/config.json` and `.memry/properties.md` are read and written by the Electron app too, and by older and newer builds of both. The Tauri writers change only the keys they own and keep every other key in value and order. The readers read every file Electron's own writers produce as Electron reads it. `tests/config_compat.rs` and `tests/properties_file.rs` check this against files made by running the Electron code (`tests/fixtures/gen-config-vectors.mjs`, `gen-properties-vectors.mjs`).

## Measured cost

Measured on 30 October 2026 on an Apple M5 Pro running other builds (load average 7 to 20), release build:

| What                                                                                     | Result                                                    |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Watcher start on the `pnpm seed1k` vault (1000 notes, 14 folders), until `start` returns | 6 to 15 ms (7 runs)                                       |
| The same, until the start rescan is done                                                 | 8 to 33 ms                                                |
| Watcher CPU while the vault is idle, over 60 s                                           | 0.023 to 0.034 % of one core (7 runs)                     |
| One write-back pass on a 12 KB note                                                      | median 40 to 42 ms, p90 59 to 62 ms (2 runs of 50 passes) |

The write-back pass misses its 20 ms budget. About 30 ms of it is the Markdown converter's serialization, which also misses its own budget (#3600). Writing the file safely (a temp file, `fsync`, then a rename) takes most of the rest.

To measure again:

```bash
cargo test -p memry-desktop --release writeback_perf -- --ignored --nocapture
pnpm seed1k --vault=/tmp/seed1k
MEMRY_BENCH_VAULT=/tmp/seed1k cargo test -p memry-desktop --release --test watch_perf -- --ignored --nocapture
```
