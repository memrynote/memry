---
tags:
  - notes-101
level: Beginner
summary: 'Bold, italic, colors, headings, alignment, comments, dates and link previews'
---
Text is the base layer. Everything on this page is live: click into it and change it.

## Marks on a selection

Select text and a toolbar appears. The same marks work from the keyboard and from Markdown shortcuts typed as you write:

- **Bold**: Cmd+B, or wrap text in two asterisks
- *Italic*: Cmd+I, or one asterisk
- <span style="text-decoration:underline">Underline</span>: Cmd+U
- ~~Strikethrough~~: Cmd+Shift+S, or two tildes
- `Inline code`: Cmd+E, or a backtick on each side
- A [web link](https://docs.memrynote.com): select text and use the toolbar's link button

On Windows and Linux use Ctrl where this guide says Cmd.

## Color

The toolbar's color menu sets the text color and the highlight: <span style="color:red">red text</span>, <span style="background-color:yellow">highlighted</span>, <span style="color:blue;background-color:gray">both at once</span>, and marks combine, as in <span style="color:purple">**bold purple**</span>. Colors are stored as small style tags, so other Markdown apps show the plain text.

## Headings

Type `#` and a space for a heading, up to six hashes. The section titles on this page are Heading 2. The rest, for reference:

### Heading 3

#### Heading 4

##### Heading 5

###### Heading 6

Headings feed the outline, the mind map and heading links like `[[Note#Heading]]`.

## Alignment and block color

Open a block's menu (hover it and click the six dots) to change alignment or color of the whole block:

<!-- align:center -->
A centered paragraph

<!-- align:right -->
## A right-aligned heading

<!-- colors:{"textColor":"blue","backgroundColor":"yellow"} -->
Blue text on a yellow block

<!-- colors:{"textColor":"red"} -->
<!-- align:center -->
Red and centered

Alignment and colors are stored on the line above the block as a comment, which other apps ignore.

## Hidden text

Anything inside an HTML comment stays in the file and out of sight: <!-- like this one -->. Obsidian-style percent comments work too: %% this one %%. Use them for notes to yourself that should never be read aloud.

<!-- a comment on its own line -->

## Dates

Type `@` followed by a date phrase such as "friday" to insert a date. It is a live chip: the day is ((date:eyJhbmNob3JJZCI6ImRtX24tdGV4dF8xIiwiZGF0ZUlTTyI6IjIwMjYtMDEtMTZUMTQ6MDA6MDAuMDAwWiIsImhhc1RpbWUiOnRydWUsImRhdGVGb3JtYXQiOiJyZWxhdGl2ZSIsInJlbWluZCI6Im5vbmUiLCJ0aW1lRm9ybWF0Ijoic3lzdGVtIn0)), and this one has a reminder the day before: ((date:eyJhbmNob3JJZCI6ImRtX24tdGV4dF8yIiwiZGF0ZUlTTyI6IjIwMjYtMDEtMjgiLCJoYXNUaW1lIjpmYWxzZSwiZGF0ZUZvcm1hdCI6ImZ1bGwiLCJyZW1pbmQiOiIxZCIsInRpbWVGb3JtYXQiOiJzeXN0ZW0ifQ)). Click a date to change it, its format or its reminder. Dates also show on the calendar's day panel.

## Link previews

Paste a URL and Memry offers four ways to keep it: plain **URL**, an inline **Mention** chip, an **Embed** for a video it recognizes, or a **Bookmark** card. A mention is a small titled chip, like ((mention:https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FApollo%5FGuidance%5FComputer)). Only the URL is stored in the file.

## Comments

Select text and press **Comment** in the toolbar to leave a note to yourself or a reviewer. The comment appears beside the marked text in the right rail, and can be resolved or deleted.

## Dividers

Type three dashes on an empty line (or use the slash menu's **Divider**) for a horizontal rule. On disk it is written as three asterisks, so it never gets mistaken for frontmatter:

***

Next: [[02 Lists, checklists and tasks]].
