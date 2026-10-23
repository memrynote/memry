import type { NoteSpec } from '../../specs.ts'
import { lesson } from './lesson.ts'

// The notes the portal lesson points at. Anchors (` ^launch`) are what a portal
// names; the editor hides them, and they are plain text in the file.
const SOURCES = 'Notes 101/Portal examples'

export const portalNotes: NoteSpec[] = [
  lesson(
    'n-portals',
    '14 Portals',
    '🪟',
    'Intermediate',
    'Show a block or a whole note somewhere else, and edit it from both places',
    (
      b
    ) => `A portal shows part of another note inside this one, live. Type in the portal and the other note changes. Nothing is copied: this note stores only a reference.

## Make a portal

**Insert:** type \`((\` and start typing. Blocks come first, then notes. **Enter** puts the portal here, folded. **⌘ Enter** on a name with no match creates that note and shows it whole. The slash menu's **Portal** opens the same search.

You can also open a block's menu and choose **Copy as portal**, then paste it in any note.

## Folded first

A portal opens folded: you see the block, not its children. **Landing** below has three children in [[Apollo 11 timeline]].

${b.portal('n-portal-timeline', ['landing'])}

Click the arrow beside it to open it. A block you open shows all of its children.

## Add to it from here

Click at the end of the block, press **Enter**, then **Tab**, and type. The new line is saved in [[Apollo 11 timeline]], as the last child of **Landing**. In this portal it shows alone, so the portal stays about what you came for. The rest are counted as **hidden**.

${b.portal('n-portal-timeline', ['landing'], { landing: { show: ['manual'] } })}

Click **hidden** to bring a block in. **Show all** (\`⌥ ⇧ A\`) brings all of them. To take one out again, put the caret in it and press \`⌘ ⇧ H\`. That changes this portal only.

## Open all of it

${b.portal('n-portal-timeline', ['launch'], { launch: { hide: [] } })}

## More than one block

A portal can start from several blocks of the same note.

${b.portal('n-portal-timeline', ['launch', 'return'])}

## Widen a portal

Put the caret inside a portal that starts deep in a note, and a small bar appears at its top. The path shows where the block lives: click a name to include that parent. **⌘ Z** puts it back. The \`···\` menu opens the source beside this note, copies the contents or a link, and removes the portal. Removing a portal never touches the source.

${b.portal('n-portal-timeline', ['manual'], { manual: { show: ['fuel'] } })}

## A whole note, or a search

${b.portalNote('n-portal-terms')}

A portal can also hold a search. It lists every block that matches and refreshes as your notes change. Results open their note when you click them.

${b.portalSearch('Eagle')}

## See where a block is used

Open [[Apollo 11 timeline]]. A small number follows **Landing**: in how many places other notes show it or link to it. This lesson shows it twice, so it says 2. Click the number to jump to those places. A note that shows its own block does not count.

## Move it like a block

A portal is one block. Press **Backspace** at the start of its first line to select it, then **Tab** to indent, **⌘ ⇧ ↑** to move, or drag the handle. **Backspace** again removes the portal.

## When the source changes

Delete the block a portal shows and the portal says so and offers **Pick another**. Delete a note, or a block other notes show, and Memry asks first: inside a portal you can choose **Hide here instead**. If a portal would show itself, it stops after one level.`
  ),
  {
    key: 'n-portal-timeline',
    title: 'Apollo 11 timeline',
    folder: SOURCES,
    tags: ['notes-101'],
    emoji: '🚀',
    body: () => `- Launch day ^launch
  - Saturn V lifts off from Kennedy Space Center ^liftoff
  - Three astronauts aboard: Armstrong, Aldrin, Collins ^crew
  - Trans-lunar injection after one and a half orbits ^tlinj
- Landing ^landing
  - Eagle separates from Columbia ^separ
  - Armstrong takes manual control near the crater ^manual
    - Fuel for about 25 seconds left at touchdown ^fuel
  - "Tranquility Base here, the Eagle has landed" ^quote
- Return ^return
  - Splashdown in the Pacific, eight days after launch ^splash
`,
    created: 0,
    modified: 0
  },
  {
    key: 'n-portal-terms',
    title: 'Mission terms',
    folder: SOURCES,
    tags: ['notes-101'],
    emoji: '📖',
    body: () => `- Eagle: the lunar module that landed
- Columbia: the command module that stayed in orbit
- Trans-lunar injection: the burn that sends a spacecraft to the Moon
- Splashdown: a landing in water
`,
    created: 0,
    modified: 0
  }
]
