# Menu Bar

memrynote has a native application menu bar. On macOS it sits in the system
menu bar. On Windows and Linux it stays out of sight until you press
<kbd>Alt</kbd> (see [below](#showing-the-menu-on-windows-and-linux)). Most
items mirror actions you can already reach from the sidebar, tabs, the
[command palette](/user-guide/command-palette), or the editor's slash menu. A menu
item runs the same command as its keyboard shortcut and its palette row.

## Menus

- **App menu** (macOS only, named “memrynote”) — About, Check for Updates,
  Settings, Hide/Show, and Quit.
- **File** — New Note, Open Quickly (search), Command Palette (<kbd>⌘</kbd>+<kbd>P</kbd>),
  Export to PDF,
  Close Tab, and Close Window. On Windows and Linux this menu also contains Settings and Quit.
- **Edit** — Undo / Redo, Cut / Copy / Paste (including Paste and Match Style),
  Delete, Select All, and Find. On macOS the system adds Speech, Start
  Dictation, and Emoji & Symbols.
- **Insert** — add a Code Block, Table, Bullet / Numbered / Task List, or an
  attachment to the note you're editing.
- **Format** — Heading 1–6 or Body for the current block, plus Bold, Italics,
  Code, Highlight, and Strikethrough for the selected text.
- **View** — Reload, zoom, full screen, Toggle Sidebar, Toggle Day Panel, and a
  Theme submenu (Light, Dark, Paper, System). Development builds also list
  Developer Tools; the released app has none.
- **Window** — standard window controls (minimize, zoom, front).
- **Help** — on Windows and Linux, About and Check for Updates; on every
  platform, Documentation (<kbd>F1</kbd>) and Keyboard Shortcuts.

## Showing the menu on Windows and Linux

Press and release <kbd>Alt</kbd> on its own. A shortcut that includes
<kbd>Alt</kbd>, such as <kbd>Alt</kbd>+<kbd>←</kbd>, leaves the menu alone.

- On **Linux** the menu bar appears at the top of the window. Press
  <kbd>Alt</kbd> again or <kbd>Esc</kbd>, or click into another window, to hide it.
- On **Windows** the window has no menu bar. <kbd>Alt</kbd> opens the menus as a
  list just below the title row. Pick an item, or press <kbd>Esc</kbd> to close it.

## About

The **About** entry opens the operating system's native about panel on macOS
and Linux, and a simple dialog showing the version on Windows.

## Check for Updates

**Check for Updates…** sits next to About — in the app menu on macOS, in Help on
Windows and Linux. It runs the same check as the button in
[Settings → General → Updates](/user-guide/settings), and always reports the
result as a toast, so the click is never silent even when automatic downloads
are on. When a new version is found it surfaces as the quiet update row at the
foot of the sidebar panel rather than a dialog.

## Insert and Format act on the focused note

The **Insert** and **Format** menus operate on the note editor that currently
has focus. If no note is open, those items do nothing. They produce the same
result as the editor's slash (`/`) menu and formatting toolbar.

## Keyboard shortcuts

Most menu items do not display a keyboard shortcut, because the app handles the
key itself and it keeps working whether or not you use the menu. These items show
their current shortcut as a label, and show your own binding once you rebind one:
Close Tab, Toggle Day Panel, Zoom In, Zoom Out, and Actual Size.
**Help → Documentation** shows <kbd>F1</kbd>, the fixed shortcut for opening the
online docs at [docs.memrynote.com](https://docs.memrynote.com). Toggle Sidebar
shows none, because <kbd>⌘</kbd>+<kbd>B</kbd> is Bold while the caret is in a
note. See [Keyboard Shortcuts](/user-guide/keyboard-shortcuts) for the full list.
