# A Tour of memrynote

A 60-second lap through the parts of the app you'll use most.

<!-- screenshot: full app window with sidebar, tabs, editor, day panel labeled -->

## The Sidebar

The left sidebar is your primary navigation.

At the very top, the **New** button creates a note in one click. Click the chevron on its right to open the create menu — New Note, Journal, Calendar, Inbox, Tasks, or Tags — the same menu as the **+** on the tab bar. Some create-menu entries open ready to act: **Calendar** pops the new-event popover, **Inbox** focuses the capture field, and **Tasks** opens your default project with the quick-add input focused. **Tags** opens the tag hub, where your tag categories live.

Opening the same views from the sidebar sections below focuses the input too (Inbox capture, Tasks quick-add), but the sidebar's **Calendar** just opens the calendar without the new-event popover — the popover is reserved for the create menu and the tab-bar **+**.

Sections from top to bottom:

- **Notes** — recent and pinned notes
- **Projects** — task projects with their incomplete-task counts
- **Tags** — your tag vocabulary
- **Bookmarks** — notes you've marked
- **Graph** — visual map of how notes link
- **Journal** — opens today's entry
- **Inbox** — capture surface

Drag any section item to reorder, or right-click for a context menu.

Inside the **Notes** tree, drag a note or folder to move it. Where you drop on a row decides what happens: the top and bottom edges reorder around that row, while the middle of a folder row drops the item **into** that folder. An empty folder takes a drop the same as a full one, so a folder you just created is ready to receive notes immediately. Notes hold no children, so dropping on a note always reorders.

The **Notes** tree loads 10,000 notes at a time, most recently modified first. If your vault holds more than that, a footer row under the tree says how many older notes it is not showing and offers **Load more** to pull in the next batch. Notes past the ceiling are never hidden silently — and they stay reachable through search either way.

At the bottom of the sidebar, a footer row holds three controls, left to right:

- **Sync status** — shows whether sync is connected; click it to open account settings (or to sign in when you're signed out).
- **Vault name** — click to open the vault menu: switch between vaults, **Open vault** to add another, or **Sign in to sync**.
- **Settings** (gear) — opens the settings modal, the same as <kbd>⌘</kbd>+<kbd>,</kbd>.

## Tabs

Across the top of the workspace. Every note, search, project view, journal entry, or settings panel opens in a tab.

- **<kbd>⌘</kbd>+<kbd>T</kbd>** — new tab
- **<kbd>⌘</kbd>+<kbd>W</kbd>** — close tab
- **<kbd>Ctrl</kbd>+<kbd>Tab</kbd>** — next tab

Pin a tab to keep it always at the front. Drag a tab to a pane edge to **split** the workspace.

## The Editor

The main writing surface uses **BlockNote** — a block-based rich text editor.

- Type `/` to open the block menu
- Type `[[` to link to another note (autocomplete suggests existing ones)
- Markdown shortcuts work inline: `# `, `- `, `**bold**`, `` `code` ``

Saves are automatic and debounced. Find-in-page is <kbd>⌘</kbd>+<kbd>F</kbd>.

## The Day Panel

A right-side panel with:

- A monthly **calendar picker** (heatmap of activity)
- **Today's tasks** (or whichever date you've focused)
- **Schedule** (events, journal preview)

Drag the left edge to resize; double-click to reset.

## Inbox & Triage

A capture surface for links, files, voice memos, and other ephemera. The **Triage** view shows one item at a time as a card so you can process them quickly.

## Tasks & Projects

Tasks live alongside notes. Two views — **list** and **kanban**. Group tasks under **projects** with custom statuses.

- Quick-add at the top of any task list
- Natural-language dates ("tomorrow", "next Friday") parse inline
- Bulk-select, drag, recurring tasks, subtasks — all there

## Search

<kbd>⌘</kbd>+<kbd>F</kbd> opens the command palette. Type to search across notes, journal entries, tasks, and inbox items at once.

- <kbd>1</kbd> through <kbd>4</kbd> scope to a single source
- `#tagname` filters by tag
- If AI embeddings are enabled, results rank by meaning too

## Settings

<kbd>⌘</kbd>+<kbd>,</kbd> opens the settings modal. The full reference lives at [Settings Reference](/user-guide/settings); the categories are:

- **Workspace** — Account, General, Templates, Editor, Journal, Tasks, Calendar
- **Preferences** — Appearance, Keyboard Shortcuts
- **Services** — AI
- **Data** — Vault, Tags, Properties

## Keyboard-First

memrynote is keyboard-friendly. The full shortcut list is at [Keyboard Shortcuts](/user-guide/keyboard-shortcuts). Highlights:

| Shortcut                   | Action                                             |
| -------------------------- | -------------------------------------------------- |
| <kbd>⌘</kbd>+<kbd>N</kbd>  | New note                                           |
| <kbd>⌘</kbd>+<kbd>F</kbd>  | Search / command palette                           |
| <kbd>⌘</kbd>+<kbd>,</kbd>  | Settings                                           |
| <kbd>⌘</kbd>+<kbd>B</kbd>  | Toggle sidebar                                     |
| <kbd>⌘</kbd>+<kbd>\\</kbd> | Split right                                        |
| <kbd>F</kbd>               | Hint mode (letter badges on every clickable thing) |

Open the in-app shortcuts dialog with <kbd>⌘</kbd>+<kbd>/</kbd> for the live list.

## What Next?

- **Just want to use it?** Open [Notes](/user-guide/notes/editing) and start writing.
- **Want to know what's there?** Browse the [User Guide](/user-guide/notes/editing) — every feature has its own page.
- **Curious how it works?** Read [Architecture](/architecture).
