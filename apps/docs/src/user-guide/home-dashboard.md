# Home Dashboard

Your landing surface when a vault opens: one or more **boards** of resizable **widgets** that surface what matters — recent notes, bookmarks, tasks, the inbox, and more.

Opening a board paints it in one pass — no entrance animation, so a full board arrives at once instead of blurring and settling into place.

<!-- screenshot: home dashboard with a board of widgets -->

## Boards

A fresh vault auto-seeds a single board named **Home**. You can keep just that one or organize work across several boards.

- **Switch boards** — pick a board from the board switcher in the header.
- **Create a board** — use **New board** in the switcher. It arrives named "New board"; rename it from the manager below.
- **Manage boards** — **Manage boards** in the switcher opens a dialog listing every board:
  - **Rename** — click a board's name (or the pencil) and type. **Enter** saves, **Esc** discards the edit and leaves the dialog open.
  - **Reorder** — drag a row by its handle. The switcher and every synced device follow the new order.
  - **Delete** — the trash button removes a board and its widgets. The last remaining board can't be deleted.

Each board stores its own set of widgets and their layout in the vault database.

### Boards sync

Boards travel with your account. Everything about a board syncs: its name and icon, which widgets are on it and how each one is configured, the exact grid position and size of every widget, and the order the boards appear in the switcher. Arrange Home once and the second machine opens looking the same — the grid keeps eight columns at every window width, so a layout means the same thing on a laptop and a desktop.

One thing stays per-device on purpose: **which board is currently open**. Each machine remembers its own active board, so a laptop can sit on your Reading board while the desktop stays on Work.

Two details worth knowing:

- On a device that is signed in, Home waits for the first sync to finish before it seeds a starter board — otherwise every new machine would add one. If the server can't be reached it stops waiting after a few seconds and gives you a board anyway.
- Boards you already had before this shipped are not lost. The first sync after upgrading uploads them, so nothing is orphaned on the machine that made them.

If two devices reorder boards at the same time, the last write wins for position — both devices still end up showing the same order as each other, just not necessarily the order either one intended. Redrag once and it settles.

## Widgets

Widgets are the cards on a board. Available types:

| Widget          | Shows                                             |
| --------------- | ------------------------------------------------- |
| Recently Edited | Notes ordered by last-modified, most recent first |
| Bookmarks       | Your bookmarked notes                             |
| Tasks           | Tasks, with an inline filter and count            |
| Inbox           | Unfiled inbox items, with a triage row            |
| Folder          | The contents of a chosen folder                   |
| Calendar        | An at-a-glance calendar of upcoming entries       |
| Journal         | Today's journal entry and your current streak     |

The Calendar widget shows today's events. If you leave Memry open overnight it rolls over on its own at local midnight — the widget, its event count, and the "Next:" line all switch to the new day without a restart. The same applies after the machine wakes from sleep or the system clock changes.

The Tasks widget has a filter pill in its header, and it offers the same scopes as the Tasks page: **All**, **Today**, **Tomorrow**, **Next 7 days**. Below those come your starred [saved filters](/user-guide/tasks/filters-sorting), and last is **No due date** — open work that never got a date. The pill's label and the count next to it both follow whatever you chose. Star a filter on the Tasks page and it shows up in this dropdown on its own; there is nothing else to configure.

### Add a widget

Open the **widget gallery** (the add-widget control on the board) and click a type. The new card drops in at the bottom of the board and the grid compacts it upward. Adding the same type twice is allowed — each is an independent instance with its own configuration.

### Move, resize & remove

The board is a free-form 8-column grid (powered by react-grid-layout):

- **Move** — drag a widget by its header to reposition it; neighbours reflow.
- **Resize** — drag the grip at the bottom-right corner. Each widget has a minimum size it won't shrink below.
- **Remove** — use the control in the widget frame.

Layout changes persist automatically, at any window size. The board keeps its eight columns whatever the window width — columns get narrower rather than collapsing — so a widget always occupies the same share of the board and your arrangement is the one you left, on every launch. Columns stop narrowing once the board reaches its minimum width; from there the board scrolls sideways rather than squeezing widgets past the point of being readable.

### Density

A widget's content density (how many rows it shows) is **derived from its height** — make a card taller and it reveals more items. There is no separate size setting to manage.

## Robustness

If a board references a widget type the app no longer recognizes (for example after rolling back a version), that card renders a small **Unknown widget** placeholder instead of crashing the board. The rest of your widgets keep working.

## See Also

- [Bookmarks & Reminders](/user-guide/notes/bookmarks-reminders)
- [Inbox](/user-guide/inbox/capturing)
- [Folder View](/user-guide/folder-view)
- [Tabs & Split View](/user-guide/tabs-split-view) — Home opens as a singleton tab
