# Tabs & Split View

Open many things at once. Pin the ones you keep coming back to. Split the workspace into panes.

<!-- screenshot: split view with two panes and several tabs each -->

## Tabs

Every note, view, search, project, journal entry, or settings panel opens in a tab. Tabs persist across app restarts when **Restore Session** is on (default; see [Settings → General](/user-guide/settings#general)).

### Tab Bar

Across the top of the app. Drag to reorder. Drag onto a pane edge to split.

Tabs share the width of the bar evenly. Widen the window and they grow, up to a comfortable maximum; open more tabs, or narrow the window, and they compress — first the close button tucks away, then the title, leaving just the icon. Once tabs reach that icon-only minimum the bar scrolls sideways instead of shrinking further: scroll over it with a trackpad or mouse wheel, or use the chevrons that appear at either end. The active tab is always scrolled into view, so opening a new tab never leaves it hidden off the end. That scroll animates once per tab you activate — the chevrons appearing part-way through it no longer restart the animation, and a tab already fully in view is left where it is. If your system is set to reduce motion (macOS **Reduce motion**, Windows **Animation effects** off, or the equivalent on Linux), the bar jumps straight to the active tab instead of sliding, and the chevrons and wheel scrolling stop animating too — the tab is still brought into view either way. Changing the setting takes effect on the next scroll; no restart needed. The **+** button stays pinned at the end of the bar while it scrolls.

There is no limit on how many tabs you can have open, and memrynote never closes one for you: use the tab context menu (**Close others**, **Close to the right**) when the bar gets long.

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

Inactive workspace surfaces stay unloaded until first use. Inbox remains ready on cold open, while
heavier surfaces such as Tasks, Calendar, Graph, and the right-side Agent/Day Panel mount when the
user opens them. This keeps startup memory tied to the visible workspace instead of every possible
feature surface.

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

A small dot appears on a tab title when there are unsaved changes (rare — memrynote auto-saves). On a compressed tab the dot takes the close button's place, so unsaved work stays visible. Closing a modified tab triggers a flush before close.

## Canvases in Tabs

Canvases open as tabs too, so you can keep a board in one pane and a note in the other. Note that a note open in a visible pane is edited there, not on the canvas card — see [Cards & Links](./canvas/cards-and-links.md).

## Links in Split Panes

Each pane handles its own links. Clicking an external link or a `[[wiki link]]` in either pane opens it from that pane, and closing one pane leaves the other pane's links working.

## See Also

- [Folder View](/user-guide/folder-view) — opens in a tab like everything else
- [Canvas Overview](./canvas/overview.md)
- [Keyboard Shortcuts](/user-guide/keyboard-shortcuts)
