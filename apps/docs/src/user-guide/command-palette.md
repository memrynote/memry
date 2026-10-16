# Command Palette

Press <kbd>⌘</kbd>+<kbd>P</kbd> (<kbd>Ctrl</kbd>+<kbd>P</kbd> on Windows and Linux) to run any command by name, from anywhere in the app. The palette is for _doing_ something: opening a page, creating an item, changing a setting. To find a note, task or inbox item, use [Search](/user-guide/search) with <kbd>⌘</kbd>+<kbd>K</kbd>.

Every row is a command. The same command also runs from its keyboard shortcut, from the [menu bar](/user-guide/menu-bar) and from the button that used to be the only way to reach it, so a command behaves the same wherever you start it. Rows show the shortcut the command has right now, including any you changed in [Settings → Keyboard Shortcuts](/user-guide/settings#keyboard-shortcuts).

## What it lists

With the field empty, the palette lists commands in this order:

1. **Commands for what you are looking at.** The heading names it: **This note**, **This journal**, **This project**, **These tasks**, **This canvas**, **This folder**, **This tag** or **This file**. For a note these include Find, Export to PDF, Version history and New note from this note. Switch to another tab and this section changes with it.
2. **Recent.** The last five commands you ran from the palette, most recent first.
3. **Everything else, by group:** Navigation, Create, Tabs, Editor, View, Settings, Sync, Help and App.

Settings has one row for each settings section, such as **Open Settings: Appearance**, so you can jump straight to it.

The palette lists only commands that can run at that moment. **Pin Tab** needs a tab, **Sync Now** needs sync to be set up, and a note command appears only while a note is open. A command whose label depends on state says so, for example **Unpin Tab** for a pinned tab.

## Finding a command

Type part of a name. A query matches the start of the command's name, the start of any word in it, or its letters in order, so `side`, `tog sid` and `tsb` all find **Toggle Sidebar**. The group name works as a keyword too: `theme` lists every theme command. Commands you ran recently rank above an equal match, and commands for the current tab rank above those for the whole app.

| Key                         | Action                   |
| --------------------------- | ------------------------ |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Move the selection       |
| <kbd>Enter</kbd>            | Run the selected command |
| <kbd>Esc</kbd>              | Close the palette        |

The palette closes first and then runs the command, so a command that opens a dialog or a picker leaves focus in that dialog. A command that needs more input opens its usual dialog instead of asking inside the palette, and a command that deletes something asks you to confirm in the same place it always did.

If nothing matches, the palette says so and offers **Search notes** (<kbd>⌘</kbd>+<kbd>K</kbd>). That button is also in the bar at the bottom, for anyone who learned <kbd>⌘</kbd>+<kbd>P</kbd> as search in an earlier version.

## Changing the shortcut

The palette's own shortcut is rebindable like the others. Open [Settings → Keyboard Shortcuts](/user-guide/settings#keyboard-shortcuts) and look for **Command Palette**. The same screen lists every command that has a keyboard shortcut. Commands without one, such as the theme and settings rows, are reachable only from the palette and the menu bar.
