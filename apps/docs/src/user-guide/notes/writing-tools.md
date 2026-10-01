# Writing Tools

Tools for drafting in a note: try other wordings in place, fade text out without deleting it,
keep leftovers beside the note, and ask the AI to check or trim your writing.

All of them sit behind one **Writing tools** button (the pen) in the note chrome, left of the
reminder bell. Its menu opens the rail beside the note on **Alternatives**, **Overflow** or **Lab**,
with a count next to each, and turns the word count on or off. Pick the open one again to close the
rail. Inside the rail, tabs switch between the three. Most of the time you won't need the button:
adding an alternative or stashing text opens the rail on the right tab by itself.

## Alternatives

Select a word, sentence or paragraph and choose **Add alternative** from the right-click menu, or
press <kbd>⌥</kbd>+<kbd>⌘</kbd>+<kbd>A</kbd>. Its card opens in the rail: type another version and
press <kbd>Enter</kbd>.

Text with alternatives gets a dashed underline and one small dot per version, the original first. With the caret in or next to
it and the pointer over it, <kbd>↑</kbd> / <kbd>↓</kbd> swap the versions in place so you read each
one in context. The filled dot marks the version that is showing; past five versions the dots stop growing and the hint above the text shows the exact position. "a" and
"an" in front of the text follow the new first letter.

In the card, the original is always listed. Click a row to show it, hover a row to remove it.

### Suggest alternatives

With AI turned on, **Suggest alternatives** in the right-click menu asks your inline AI provider
for up to five versions. A sparkle marks the AI's suggestions and a person icon marks yours.
**Remove suggestions** deletes only the AI's. When no versions are left the underline goes away.

## Ghost

Right-click a selection and choose **Ghost** to fade it out. It stays in the note, so you can read
the paragraph without it and bring it back later with **Revive**. Ghosted text is left out of the
word count.

## Overflow

A scratch list for the note: spare paragraphs, words you like, an outline. **Stash in overflow**
moves the selected text there with its formatting: bold, links, wiki links and mentions show in the
list as they did in the note, and come back the same way when you drag the item into the note or
copy and paste it. Text you type into the list directly is plain.

## Lab

Needs AI to be turned on. Lab never rewrites your text.

- **Checks**: _Convoluted sentences_ and _Words that don't fit the tone_ underline the spots it
  finds; click a result to jump to it.
- **Trim**: _Slight trim_, _Tighten_, _Even sharper_ or _Cut in half_ dim the parts it would cut.
  The bar at the bottom steps through them: **Keep**, **Cut**, or **Cut all**. **Stop** clears them.

## Word count

**Show word count** in the Writing tools menu turns on a live count, shown as plain text next to
the button. The setting is kept on this device.

## Right-click menu

The note editor's right-click menu has spelling suggestions, **Cut**, **Copy**, **Paste**, **Select
All**, **Undo**, **Redo**, then the writing tools above.

## Sync and files

Alternatives, ghosts and overflow sync with the note and are end-to-end encrypted like the rest of
it. They are not saved in the note's markdown file, so they don't appear in exports, and if the
note is rebuilt from its file after an outside edit, ghosts are lost.
