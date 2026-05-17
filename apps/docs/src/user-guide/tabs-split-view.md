# Tabs & Split View

Open many things at once. Pin the ones you keep coming back to. Split the workspace into panes.

<!-- screenshot: split view with two panes and several tabs each -->

## Tabs

Every note, view, search, project, journal entry, or settings panel opens in a tab. Tabs persist across app restarts when **Restore Session** is on (default; see [Settings → General](/user-guide/settings#general)).

### Tab Bar

Across the top of the app. Drag to reorder. Drag onto a pane edge to split.

### Tab Context Menu

Right-click any tab:

- Close
- Close others
- Close to the right
- Pin / unpin
- Duplicate
- Move to new window (where supported)
- Copy link to this tab

## Pinning

Pin a tab to keep it at the front of the bar. Pinned tabs:

- Show only their icon (compact)
- Don't close on middle-click
- Survive bulk-close commands
- Restore first on app launch

Useful for: today's journal, your "now" note, the shared project.

## Opening Items

Single-clicking a note, view, search result, or sidebar item opens a permanent tab. If that item is already open, memrynote focuses the existing tab instead of creating another copy.

## Mouse Navigation

Mouse Back and Forward side buttons move through tab focus history across the whole window, including split panes. Back returns to the previously focused tab; Forward replays the next tab after a Back action. Opening or selecting another tab starts a new history path.

## Split View

Drag a tab to the left, right, top, or bottom edge of the window to open a second pane.

<!-- screenshot: tab being dragged into a drop zone to create a split -->

### Drop Zones

When dragging a tab, the workspace highlights drop zones:

- Center — same pane
- Left / right — split horizontally
- Top / bottom — split vertically
- Beyond the edge — new window

Drop in a zone to create or move into a pane.

### Resizing Panes

- Drag the divider between panes
- Double-click the divider to reset to default 50/50

Resize ratios persist across sessions.

### Pane Navigation (Chord)

| Action               | Shortcut                                             |
| -------------------- | ---------------------------------------------------- |
| Split right          | <kbd>⌘</kbd>+<kbd>\\</kbd>                           |
| Split down           | <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>\\</kbd>              |
| Close split pane     | <kbd>⌘</kbd>+<kbd>⌥</kbd>+<kbd>W</kbd>               |
| Focus right pane     | <kbd>⌘</kbd>+<kbd>K</kbd>, <kbd>⌘</kbd>+<kbd>→</kbd> |
| Focus left pane      | <kbd>⌘</kbd>+<kbd>K</kbd>, <kbd>⌘</kbd>+<kbd>←</kbd> |
| Toggle maximize pane | <kbd>⌘</kbd>+<kbd>K</kbd>, <kbd>M</kbd>              |

A chord indicator briefly flashes when the prefix is active. See [Keyboard Shortcuts](/user-guide/keyboard-shortcuts#split-view) for the full list.

## Tab Hover Preview

Hovering a tab shows a thumbnail card preview after a short delay — handy when you have many tabs of the same icon.

## Tab Persistence

If **Restore Session** is on, the entire tab and split layout restores on app launch:

- Tab order
- Pinned state
- Split layout and ratios
- Active tab per pane

## Modified Indicator

A small dot appears on a tab title when there are unsaved changes (rare — memrynote auto-saves). Closing a modified tab triggers a flush before close.

## See Also

- [Folder View](/user-guide/folder-view) — opens in a tab like everything else
- [Keyboard Shortcuts](/user-guide/keyboard-shortcuts)
