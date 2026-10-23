# Folding Long Notes

A long note is slow to re-read. Folding shows the same note at a shorter level, so you can skim it
and open only the paragraph you need. Nothing in the note changes.

## Levels

The word count in the note's top bar (for example **1,104 words**) is the level control. Click it
to open the level menu, which shows each level's word count and shortcut.

| Level    | What you see                                                                           | Who writes it         |
| -------- | -------------------------------------------------------------------------------------- | --------------------- |
| Full     | The note as written                                                                    | You                   |
| Brief    | One to three of your own sentences per paragraph, with bold, links and wiki-links kept | Picked from your text |
| Key      | The point of each paragraph and the reason for it                                      | Your agent            |
| Takeaway | One line per paragraph                                                                 | Your agent            |
| Topic    | One card per section: its heading, a one-line takeaway, and a chip per paragraph       | Your agent            |

Notes of 150 words or fewer are not folded, and the word count stays plain text. Code blocks,
tables, images and callouts are not summarized. A folded note marks where they were with a quiet
line such as "… 1 code block". Journal day entries fold the same way.

The level control stays visible on a long note even when you hide the word count.

## Moving Between Levels

- Use the menu, or press **⌘⌥1** to **⌘⌥5** (Full to Topic). The shortcuts are rebindable in
  Settings → Shortcuts. If you assigned the same keys to a new-note-in-folder shortcut, your
  shortcut wins and the fold command stays available from the menu.
- Hold **⌘** and scroll, or pinch on a trackpad, over the note to step one level.
- Press **Esc** to return to Full.

A level your agent has not written yet shows **Writing…** in the menu. Choosing it shows Brief
until the level arrives, and each paragraph swaps in as it is ready. Moving between Brief, Key and
Takeaway slides the words that both levels share. With reduced motion turned on, the level changes
at once.

## Reading a Folded Note

A folded note is read-only. Click a paragraph to open just that paragraph at full text, in place.
Click it again to fold it. **Esc** closes opened paragraphs first, then returns the note to Full.
Starting to type also returns to Full, with the caret in the paragraph you last touched, and your
first key is typed there.

At Key, Takeaway and Topic, hover a line (or focus it with the keyboard) to see the paragraph it was
written from, with the sentences it rests on underlined. At Topic, click a chip to jump to Full at
that paragraph, or click a card's heading to unfold only that section.

## Turning It On

Open Settings → AI & Agents and turn on **Summarize long notes**. It is off by default and hidden
while **Enable AI Features** is off.

Memry does not call a hosted model for this. It runs on this device through an agent you already
connected. With **Auto**, it uses the first available of Claude, Codex, Antigravity and then your
local model. Pick one in the row's menu to always use that agent. A chosen agent that is not found
is never replaced by another one.

- Only notes you open are summarized. Importing notes does nothing.
- When you open a long note, missing levels are written. After you edit and pause for about 30
  seconds, only the changed sections are written again.
- Your note text is sent only to the agent you picked, the same way an agent chat is. The Memry
  server never sees it.

Without an agent, the menu offers Full and Brief and says why. Brief works without one, because it
only picks sentences you wrote. If a run fails, the menu and the Settings row show **Last run
failed · Retry**.

## Where the Summaries Are Kept

Summaries are a cache on this device (`note_fold_chunks` in index.db). They are not synced, so each
device writes its own. A section's summary is reused while its text does not change, and rows
older than 90 days are removed. See [Local Storage](/architecture/local-storage#note-fold-cache).

## Known Limits

- The folded view shows paragraphs. A list becomes one paragraph in which each item is its own
  sentence, and a full stop is added to an item that has none. Nesting is flattened.
- Key, Takeaway and Topic need an agent. There is no offline version of them.
- Summaries are written in the note's language, and sentence splitting follows that language.
