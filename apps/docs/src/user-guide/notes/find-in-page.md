# Find in Page

Search the current note with <kbd>⌘</kbd>+<kbd>F</kbd>. For global search, use [the command palette](/user-guide/search) instead.

<!-- screenshot: find-in-page bar at the top of a note -->

## Opening the Bar

Press <kbd>⌘</kbd>+<kbd>F</kbd> while focused on a note. A floating bar appears at the top with:

- Query input
- Match counter (`3 of 12`)
- Up / down arrows
- Close button

## Navigating Matches

| Action         | Shortcut                                  |
| -------------- | ----------------------------------------- |
| Next match     | <kbd>Enter</kbd> or down arrow            |
| Previous match | <kbd>⇧</kbd>+<kbd>Enter</kbd> or up arrow |
| Close          | <kbd>Esc</kbd>                            |

Matches are highlighted inline; the active match scrolls into view.

## Case Sensitivity

The bar matches case-insensitively by default. Toggle case sensitivity from the bar's options menu.

## Whole Word

Whole-word matching is also a toggle in the options menu.

## Scope

Find-in-page is **local to the current note**. To search across notes, journals, tasks, and the inbox, open the [command palette](/user-guide/search) with <kbd>⌘</kbd>+<kbd>K</kbd>.

## Inside Embedded PDF Previews

PDF previews use their own embedded find — memrynote's find bar doesn't reach into them. Click into the PDF and use the embedded viewer's controls.

## Performance

Find runs against the rendered document, so it sees what you see (including code blocks, list items, callout text). It does not cross block boundaries that aren't visually adjacent.

Typing in the bar is debounced: on a long note the matches update a moment after you stop typing rather than on every character. Whatever you typed last always gets searched, and pressing <kbd>Enter</kbd> or <kbd>⇧</kbd>+<kbd>Enter</kbd> searches straight away instead of waiting. Editing the note while the bar is open re-runs the search too, so the match count and highlights stay in step with the text.
