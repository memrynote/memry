---
tags:
  - notes-101
level: Intermediate
summary: 'Show a block or a whole note somewhere else, and edit it from both places'
---
A portal shows part of another note inside this one, live. Type in the portal and the other note changes. Nothing is copied: this note stores only a reference.

## Make a portal

**Insert:** type `((` and start typing. Blocks come first, then notes. **Enter** puts the portal here, folded. **⌘ Enter** on a name with no match creates that note and shows it whole. The slash menu's **Portal** opens the same search.

You can also open a block's menu and choose **Copy as portal**, then paste it in any note.

## Folded first

A portal opens folded: you see the block, not its children. **Landing** below has three children in [[Apollo 11 timeline]].

```memry-portal
{
  "v": 1,
  "note": "note_zZW7UGLPZtno",
  "blocks": [
    "landing"
  ]
}
```

Click the arrow beside it to open it. A block you open shows all of its children.

## Add to it from here

Click at the end of the block, press **Enter**, then **Tab**, and type. The new line is saved in [[Apollo 11 timeline]], as the last child of **Landing**. In this portal it shows alone, so the portal stays about what you came for. The rest are counted as **hidden**.

```memry-portal
{
  "v": 1,
  "note": "note_zZW7UGLPZtno",
  "blocks": [
    "landing"
  ],
  "open": {
    "landing": {
      "show": [
        "manual"
      ]
    }
  }
}
```

Click **hidden** to bring a block in. **Show all** (`⌥ ⇧ A`) brings all of them. To take one out again, put the caret in it and press `⌘ ⇧ H`. That changes this portal only.

## Open all of it

```memry-portal
{
  "v": 1,
  "note": "note_zZW7UGLPZtno",
  "blocks": [
    "launch"
  ],
  "open": {
    "launch": {
      "hide": []
    }
  }
}
```

## More than one block

A portal can start from several blocks of the same note.

```memry-portal
{
  "v": 1,
  "note": "note_zZW7UGLPZtno",
  "blocks": [
    "launch",
    "return"
  ]
}
```

## Widen a portal

Put the caret inside a portal that starts deep in a note, and a small bar appears at its top. The path shows where the block lives: click a name to include that parent. **⌘ Z** puts it back. The `···` menu opens the source beside this note, copies the contents or a link, and removes the portal. Removing a portal never touches the source.

```memry-portal
{
  "v": 1,
  "note": "note_zZW7UGLPZtno",
  "blocks": [
    "manual"
  ],
  "open": {
    "manual": {
      "show": [
        "fuel"
      ]
    }
  }
}
```

## A whole note, or a search

```memry-portal
{
  "v": 1,
  "note": "note_bxCAFGvEgmbU"
}
```

A portal can also hold a search. It lists every block that matches and refreshes as your notes change. Results open their note when you click them.

```memry-portal
{
  "v": 1,
  "search": {
    "text": "Eagle",
    "limit": 20
  }
}
```

## See where a block is used

Open [[Apollo 11 timeline]]. A small number follows **Landing**: in how many places other notes show it or link to it. This lesson shows it twice, so it says 2. Click the number to jump to those places. A note that shows its own block does not count.

## Move it like a block

A portal is one block. Press **Backspace** at the start of its first line to select it, then **Tab** to indent, **⌘ ⇧ ↑** to move, or drag the handle. **Backspace** again removes the portal.

## When the source changes

Delete the block a portal shows and the portal says so and offers **Pick another**. Delete a note, or a block other notes show, and Memry asks first: inside a portal you can choose **Hide here instead**. If a portal would show itself, it stops after one level.
