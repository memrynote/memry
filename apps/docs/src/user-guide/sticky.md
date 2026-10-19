# Sticky

A small note that opens over any app, takes what is on your mind, and sends it where it belongs: a note, a task, or today's journal.

## Opening it

Press `Cmd`/`Ctrl` + `Shift` + `M`, or the hotkey you set under [Settings → Keyboard Shortcuts → System-wide → Sticky](/user-guide/settings#sticky-shortcut). memrynote has to be running with a vault open. The sticky has its own hotkey, separate from quick capture's. On Windows and Linux the app quits when you close its last window unless **Minimize to Tray** is on ([Window Behavior](/user-guide/settings#window-behavior)), and then the hotkey does nothing until you start memrynote again.

The sticky opens next to the pointer. If you have an unsent draft, it opens on your most recent one; otherwise it opens blank.

## Writing and sending

Pick where the text goes in the bar at the top, or with the keyboard:

| Key                | Sends as                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cmd`/`Ctrl` + `1` | **Note** — a new note in the vault's `Sticky` folder. The first line is the title, the rest is the body.                                                |
| `Cmd`/`Ctrl` + `2` | **Task** — the first line uses the same quick-add grammar as the task bar (`@tomorrow`, `!high`, `#tag`, `+project`); the rest becomes the description. |
| `Cmd`/`Ctrl` + `3` | **Journal** — appended as a new paragraph to today's journal entry.                                                                                     |

Task and Journal only appear when those modules are turned on in [Settings → Modules](/user-guide/settings).

Press `Cmd`/`Ctrl` + `Enter` (or **Send**) to send. A confirmation shows what was created:

- **Open** (`Cmd`/`Ctrl` + `O`) shows it in the main window.
- **Undo** (`Cmd`/`Ctrl` + `Z`) deletes the note or task again and puts the text back on the sticky. A journal send has no Undo, because the paragraph has already merged into the entry; edit the entry instead.

`Option`/`Alt` + `Cmd`/`Ctrl` + `Enter` sends and closes the sticky at once.

If a send fails (for example a locked note folder), the sticky says why and keeps your text.

### Links, files and voice memos

The sticky is for text: a link you write on it is sent as text, like the rest. To save a link with its preview, an image, a PDF or a voice memo to the [Inbox](/user-guide/inbox/capturing), use quick capture instead.

## Drafts

Whatever you write is saved as a draft while you type, and the sticky shows **Saved**. Drafts sync to your other desktops.

- **Esc**, the **–** button, or clicking outside tucks the sticky away. The draft stays.
- An empty sticky leaves nothing behind when you tuck it.
- `Cmd`/`Ctrl` + `Backspace` deletes the draft; **Undo** brings it back for a few seconds.

## The edge tab

While drafts are waiting, a small tab sits on the edge of the screen with their count. Hover it to see your drafts and click one to open the sticky on it, or click **New sticky** for a blank one. The tab disappears when the sticky opens and when the last draft is sent or deleted.

## Settings

Under [Settings → General → Sticky](/user-guide/settings#sticky):

- **New stickies send as** — the kind a blank sticky starts on: the last one you used, or always Note, Task or Journal.
- **Tuck to** — the screen edge the tab sits on.

The sticky and its tab use your theme, color theme and accent color from [Settings → Appearance](/user-guide/settings#appearance), and follow them when you change them.
