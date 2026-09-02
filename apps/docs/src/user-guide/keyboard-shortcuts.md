# Keyboard Shortcuts

Default shortcuts. Entries in the Navigation, Tabs, and View categories are rebindable in [Settings → Keyboard Shortcuts](/user-guide/settings#keyboard-shortcuts); Editor formatting keys belong to the note editor and are listed there read-only.

> macOS uses <kbd>⌘</kbd>; Windows / Linux use <kbd>Ctrl</kbd> for the same action. <kbd>Ctrl</kbd>+<kbd>Tab</kbd> always uses <kbd>Ctrl</kbd> on every platform.

## Navigation

| Action                | Shortcut                                               |
| --------------------- | ------------------------------------------------------ |
| New note              | <kbd>⌘</kbd>+<kbd>N</kbd>                              |
| Go to sidebar section | <kbd>⌘</kbd>+<kbd>1</kbd> … <kbd>⌘</kbd>+<kbd>6</kbd>  |
| Open search           | <kbd>⌘</kbd>+<kbd>K</kbd> or <kbd>⌘</kbd>+<kbd>P</kbd> |
| Open settings         | <kbd>⌘</kbd>+<kbd>,</kbd>                              |

> Hold <kbd>⌘</kbd> (<kbd>Ctrl</kbd> on Windows / Linux) to reveal the section numbers on the sidebar icons, then press the number to jump — <kbd>⌘</kbd>+<kbd>1</kbd> opens Home, <kbd>⌘</kbd>+<kbd>2</kbd> Inbox, and so on. Numbers follow the sidebar's visible top-to-bottom order (Home is always 1), so they shift if you hide a section. This shortcut works everywhere, including inside the editor, and is fixed rather than rebindable.

## Tabs

| Action            | Shortcut                                    |
| ----------------- | ------------------------------------------- |
| New tab           | <kbd>⌘</kbd>+<kbd>T</kbd>                   |
| Close tab         | <kbd>⌘</kbd>+<kbd>W</kbd>                   |
| Close all tabs    | <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>W</kbd>      |
| Reopen closed tab | <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>T</kbd>      |
| Next tab          | <kbd>Ctrl</kbd>+<kbd>Tab</kbd>              |
| Previous tab      | <kbd>Ctrl</kbd>+<kbd>⇧</kbd>+<kbd>Tab</kbd> |
| Pin / unpin tab   | <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>P</kbd>      |
| Duplicate tab     | <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>D</kbd>      |

> **Reopen closed tab** brings back the most recently closed tab at its original position and focus. Press it repeatedly to walk back through closed tabs, most recent first — it also recovers tabs closed in bulk by **Close all tabs**. The history is kept for the current session only.

## Split View

Some commands use a chord — press <kbd>⌘</kbd>+<kbd>K</kbd>, release, then press the next key.

| Action               | Shortcut                                                  |
| -------------------- | --------------------------------------------------------- |
| Split right          | <kbd>⌘</kbd>+<kbd>\\</kbd>                                |
| Split down           | <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>\\</kbd>                   |
| Close split pane     | <kbd>⌘</kbd>+<kbd>⌥</kbd>+<kbd>W</kbd>                    |
| Focus right pane     | <kbd>⌘</kbd>+<kbd>K</kbd>, then <kbd>⌘</kbd>+<kbd>→</kbd> |
| Focus left pane      | <kbd>⌘</kbd>+<kbd>K</kbd>, then <kbd>⌘</kbd>+<kbd>←</kbd> |
| Focus pane above     | <kbd>⌘</kbd>+<kbd>K</kbd>, then <kbd>⌘</kbd>+<kbd>↑</kbd> |
| Focus pane below     | <kbd>⌘</kbd>+<kbd>K</kbd>, then <kbd>⌘</kbd>+<kbd>↓</kbd> |
| Toggle maximize pane | <kbd>⌘</kbd>+<kbd>K</kbd>, then <kbd>M</kbd>              |
| Reset split ratios   | <kbd>⌘</kbd>+<kbd>K</kbd>, then <kbd>=</kbd>              |

A chord indicator briefly flashes when the prefix is active.

## Editor

| Action           | Shortcut                               |
| ---------------- | -------------------------------------- |
| Undo             | <kbd>⌘</kbd>+<kbd>Z</kbd>              |
| Redo             | <kbd>⇧</kbd>+<kbd>⌘</kbd>+<kbd>Z</kbd> |
| Bold             | <kbd>⌘</kbd>+<kbd>B</kbd>              |
| Italic           | <kbd>⌘</kbd>+<kbd>I</kbd>              |
| Underline        | <kbd>⌘</kbd>+<kbd>U</kbd>              |
| Insert wiki link | Type `[[`                              |
| Open block menu  | Type `/`                               |
| Indent block     | <kbd>Tab</kbd>                         |
| Outdent block    | <kbd>⇧</kbd>+<kbd>Tab</kbd>            |
| Find in page     | <kbd>⌘</kbd>+<kbd>F</kbd>              |

<kbd>Tab</kbd> and <kbd>⇧</kbd>+<kbd>Tab</kbd> act on every block in the selection, not only the one holding the cursor.

With the cursor inside a table cell:

| Action                 | Shortcut                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Next / previous cell   | <kbd>Tab</kbd> / <kbd>⇧</kbd>+<kbd>Tab</kbd>                                             |
| Row and column actions | <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>Enter</kbd>, <kbd>⇧</kbd>+<kbd>F10</kbd>, or Context Menu |

The menu holds Delete row, Add row above / below, Delete column and Add column
left / right, is named after the cell it acts on, and returns the cursor to that
cell on <kbd>Esc</kbd>. See
[Editing notes](./notes/editing.md#row-and-column-actions-from-the-keyboard).

## View

| Action                         | Shortcut                                  |
| ------------------------------ | ----------------------------------------- |
| Toggle sidebar                 | <kbd>⌘</kbd>+<kbd>B</kbd>                 |
| Show keyboard shortcuts dialog | <kbd>⌘</kbd>+<kbd>/</kbd> or <kbd>?</kbd> |

> <kbd>⌘</kbd>+<kbd>B</kbd> is shared on purpose: with the caret in a note it bolds
> the selection and nothing else, and everywhere else it toggles the sidebar. Rebind
> **Toggle Sidebar** if you would rather keep the two apart.

Memry remembers whether the sidebar is open. Close it and it stays closed when you
switch vaults and when you next start the app, until you open it again.

The same shortcut reference opens from the question-mark button in the sidebar footer.
It groups shortcuts into General, Tabs & Splits, Inbox, Journal, Notes / Editor, Tasks,
and Settings sections so you can scan by workflow.

## Help

| Action                    | Shortcut      |
| ------------------------- | ------------- |
| Open documentation online | <kbd>F1</kbd> |

<kbd>F1</kbd> opens [docs.memrynote.com](https://docs.memrynote.com) in your browser —
the same page you reach from **Help → Documentation** in the menu bar. It works
everywhere, including inside the editor. This is a fixed menu shortcut and isn't
rebindable.

## Inbox

When the inbox or a card has focus:

| Action          | Shortcut                                  |
| --------------- | ----------------------------------------- |
| Refresh         | <kbd>R</kbd>                              |
| Open source URL | <kbd>O</kbd>                              |
| Archive         | <kbd>Delete</kbd> or <kbd>Backspace</kbd> |

## Notes Tree

When a row in the sidebar **Collections** tree has focus — click one, or open a
row's context menu and dismiss it. The arrow keys then move between rows instead
of scrolling the sidebar.

| Action                              | Shortcut                                  |
| ----------------------------------- | ----------------------------------------- |
| Next / previous row                 | <kbd>↓</kbd> / <kbd>↑</kbd>               |
| Open a folder, then step inside it  | <kbd>→</kbd>                              |
| Close a folder, or go to its parent | <kbd>←</kbd>                              |
| Delete selected (asks first)        | <kbd>Delete</kbd> or <kbd>Backspace</kbd> |

<kbd>↓</kbd> and <kbd>↑</kbd> walk every visible row in order, in and out of open
folders, and stop at the ends rather than wrapping. <kbd>→</kbd> opens a closed
folder; press it again to move onto the first item inside. <kbd>←</kbd> closes an
open folder, and on anything already closed — a note, or a folder you just shut —
it jumps out to the parent folder. Moving onto a note opens it, the same as
clicking it.

While a row is renaming, the arrow keys move the text cursor instead.

## Canvases

When a row in the sidebar **Canvases** tree has focus. Tab reaches the rows and
their **⋯** menus; there is no arrow-key tree navigation.

| Action               | Shortcut                                  |
| -------------------- | ----------------------------------------- |
| Rename               | <kbd>F2</kbd>                             |
| Delete (asks first)  | <kbd>Delete</kbd> or <kbd>Backspace</kbd> |
| Clear the filter box | <kbd>Esc</kbd>                            |

<kbd>F2</kbd> turns the row itself into a text field rather than opening a
dialog: <kbd>Enter</kbd> commits the name, <kbd>Esc</kbd> abandons it, and
clicking away commits it too.

Moving a canvas or folder has no shortcut — use **Move to folder** in the row
menu. See [Organizing Canvases](/user-guide/canvas/organizing).

## Hint Mode

Hint mode overlays letter badges on interactive elements so you can act without the mouse.

| Action             | Shortcut                                  |
| ------------------ | ----------------------------------------- |
| Activate hint mode | <kbd>F</kbd> or <kbd>⌥</kbd>+<kbd>F</kbd> |
| Pick a target      | Type the letters shown                    |
| Undo a keystroke   | <kbd>Backspace</kbd>                      |
| Exit               | <kbd>Esc</kbd>                            |

Badges are mnemonics built from each target's own name — its accessibility label,
its visible text, or its tooltip, in that order. A target whose first letter is
unique on screen gets that single letter (**Inbox** → `I`). When several targets
share a first letter they get two characters: the shared letter plus the next
distinct letter from that target's own text (**Tags** → `TA`, **Tasks** → `TS`).
Anything with no usable letter to start from — an icon-only button, or a name that
doesn't begin with A–Z — falls back to a sequential two-letter code (`AA`, `AB`,
…), and those codes never reuse a letter that is already a badge on its own.

Typing is case-insensitive and matches from the start of a badge. Each keystroke
narrows the badges in place, keys that match nothing are ignored, and
<kbd>Backspace</kbd> takes back the last character you typed. The moment what
you've typed is a complete badge, that element is clicked and focused and hint
mode exits. Only the badge overlay repaints as you type, so hint mode stays
responsive on screens with a lot of targets.

## Global Undo (Tasks)

<kbd>⌘</kbd>+<kbd>Z</kbd> undoes recent task changes within a 10-second window. Coverage includes status, priority, due date, deletion, and bulk actions.

## Customizing

Open [Settings → Keyboard Shortcuts](/user-guide/settings#keyboard-shortcuts), find a row, and click to capture a new binding. A rebind applies immediately — no restart. Conflicts are flagged inline. **Reset All** restores defaults; it's only visible if you've made changes.

Editor formatting rows (Bold, Italic, Underline) are shown for reference and cannot be reassigned: the note editor owns those keys.

You can also set a **Global Capture** hotkey there to bring memrynote to focus from any app (macOS requires Accessibility permission).
