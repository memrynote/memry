import { copyFileSync, mkdirSync, statSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { serializeDateMentionToken } from '@memry/shared/date-mention'
import type { NoteFile } from '../seed-vault/file-writer'
import { CANVASES } from './canvas'
import { seedDateOnly, seedISOAt, seedPastISOAt } from './date'
import { NOTE_IDS } from './notes'
import { taskIdForKey } from './tasks'

// ============================================================================
// iOS Parity Test — the kitchen-sink note.
//
// Every block, inline node and style the editor schema registers appears here
// at least once (see packages/editor-schema/src/registry-manifest.json), so one
// note answers "does this surface render everything?". Audio and video are
// written the way the editor writes them: as `file` blocks whose mimeType picks
// the player. The attachments are real files copied into the vault.
//
// ios-parity.test.ts parses this body with the app's own converter and fails
// when a registered type is missing or when the body stops round-tripping.
// ============================================================================

export const IOS_PARITY_NOTE_PATH = 'notes/iOS Parity Test.md'

/** Root-relative attachment folder, the form mobile writes: `attachments/<noteId>/`. */
const ATTACHMENT_DIR = NOTE_IDS.iosParityTest

export const IOS_PARITY_ATTACHMENTS = [
  'parity-cell.png',
  'parity-photo.png',
  'parity-spec.pdf',
  'parity-voice.m4a',
  'parity-clip.mp4'
] as const

const ASSET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'assets', 'ios-parity')

/** The launch day, shared with the memrynote Launch timeline and the deadline property. */
const LAUNCH_DAY = 24

const MEETING_DATE = serializeDateMentionToken({
  anchorId: 'parity-d1',
  dateISO: seedISOAt(12, 9),
  hasTime: true,
  dateFormat: 'relative',
  remind: 'none',
  timeFormat: 'system'
})

const LAUNCH_REMINDER_DATE = serializeDateMentionToken({
  anchorId: 'parity-d2',
  dateISO: `${seedDateOnly(LAUNCH_DAY)}T00:00:00.000Z`,
  hasTime: false,
  dateFormat: 'full',
  remind: '1d',
  timeFormat: 'system'
})

export const IOS_PARITY_BODY = `Test note for iOS parity. Every block type, inline type, style, tag and property type appears at least once. Headings name the section, so compare each section with desktop.

# 1. Headings (H1-H6)

## Heading level 2

### Heading level 3

#### Heading level 4

##### Heading level 5

###### Heading level 6

## 2. Inline styles

Plain, **bold**, *italic*, <span style="text-decoration:underline">underline</span>, ~~strike~~, \`inline code\`, ***bold+italic***.

Colours: <span style="color:red">red</span> <span style="color:blue">blue</span> <span style="color:green">green</span> <span style="color:purple">purple</span>, highlight: <span style="background-color:yellow">yellow</span> <span style="background-color:pink">pink</span>, both: <span style="color:red;background-color:yellow">red on yellow</span>.

## 3. Inline nodes

Link: [memry.app](https://memry.app). Wiki link: [[Dune]]. Wiki link with alias: [[Deep Work|Cal Newport book]]. Broken wiki link: [[A Note That Does Not Exist]].

Tags: #ios-parity #testing. Link mention: ((mention:https%3A%2F%2Fgithub.com%2Fmemrynote%2Fmemry)).

Date: ${MEETING_DATE}, with reminder: ${LAUNCH_REMINDER_DATE}.

## 4. Block colours and alignment

<!-- align:center -->
Centred paragraph.

<!-- align:right -->
Right-aligned paragraph.

<!-- align:justify -->
Justified paragraph: this sentence is long enough to wrap across several lines on a phone, so the justification is visible.

<!-- colors:{"textColor":"blue"} -->
Paragraph with blue text colour.

<!-- colors:{"backgroundColor":"yellow"} -->
Paragraph on a yellow background.

<!-- colors:{"textColor":"red","backgroundColor":"gray"} -->
Red text on a gray background.

## 5. Lists

- Bullet one
  - Nested bullet
    - Two levels deep
- Bullet two
1. First (1)
2. Second (2)
3. Third (3)

A paragraph in between: numbering must restart below.

1. Restarted (1)
2. Restarted (2)
   1. Nested numbered (2.1)
   2. Nested numbered (2.2)

- [x] Checked item {task:${taskIdForKey('parity-checked')}}

- [ ] Unchecked item {task:${taskIdForKey('parity-unchecked')}}

A plain checklist, not tracked as tasks:

- [x] Plain checked
- [ ] Plain unchecked

## 6. Toggle

<details data-memry-toggle>
<summary>Closed toggle (tap to open)</summary>

Hidden body text.

</details>

<details data-memry-toggle open>
<summary>Open toggle</summary>

Body of the open toggle.

<details data-memry-toggle>
<summary>Nested toggle</summary>

Deepest body.

</details>

</details>

## 7. Quote and callouts

> A plain quote block.

> A structured quote holds more than one block.
>
> - A list inside the quote
> - Second item

> [!info]
> Info callout.

> [!warning]
> Warning callout.

> [!error]
> Error callout.

> [!success]
> Success callout.

## 8. Code

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}\`
}
\`\`\`

\`\`\`python
def greet(name):
    return f"Hello, {name}"
\`\`\`

## 9. Divider

Above the divider.

***

Below the divider.

## 10. Table

<!-- table-colors:{"1:1":{"backgroundColor":"green"},"2:1":{"textColor":"red","backgroundColor":"yellow"}} -->
<!-- table-layout:{"columnWidths":[160,null,120]} -->
| Feature             | Status        | Note                                              |
| ------------------- | ------------- | ------------------------------------------------- |
| **Read**            | Done          | Wiki: [[Dune]]                                    |
| Edit                | In review     | Tag: #ios-parity                                  |
| [x] inline checkbox | [ ] unchecked | ![cell](attachments/${ATTACHMENT_DIR}/parity-cell.png) |

## 11. Attachments

![parity-photo.png](attachments/${ATTACHMENT_DIR}/parity-photo.png)

<!-- file:{"url":"attachments/${ATTACHMENT_DIR}/parity-spec.pdf","name":"parity-spec.pdf","size":12978,"mimeType":"application/pdf"} -->

<!-- file:{"url":"attachments/${ATTACHMENT_DIR}/parity-voice.m4a","name":"parity-voice.m4a","size":27680,"mimeType":"audio/mp4"} -->

<!-- file:{"url":"attachments/${ATTACHMENT_DIR}/parity-clip.mp4","name":"parity-clip.mp4","size":65093,"mimeType":"video/mp4"} -->

## 12. Embeds

![bookmark](https://github.com/memrynote/memry)

![embed](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

![whiteboard](memry://canvas/${CANVASES[0].id})

## 13. Task block

- [ ] Renew driver license {task:${taskIdForKey('inbox-renew-license')}}

## 14. Non-ASCII

Türkçe: çğıöşü ÇĞİÖŞÜ. Grüße, 世界, «citation» 🙂

## 15. Review comments (read only on iOS)

This sentence has {==a highlighted comment==}{>>id=critic-comment-4061-10gv85t;type=comment | Check this renders on iOS<<}, an insertion and a deletion.

## 16. Diagram (Mermaid)

\`\`\`mermaid
flowchart LR
  Capture --> Inbox
  Inbox --> Note
  Inbox --> Task
  Task --> Calendar
\`\`\`

## 17. Math

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$
`

const MODIFIED = seedPastISOAt(-1, 20, 15)

export const IOS_PARITY_METADATA = {
  id: NOTE_IDS.iosParityTest,
  path: IOS_PARITY_NOTE_PATH,
  title: 'iOS Parity Test',
  emoji: '🧪',
  createdAt: seedPastISOAt(-6, 10, 0),
  modifiedAt: MODIFIED
}

export const IOS_PARITY_NOTE: NoteFile = {
  relativePath: IOS_PARITY_NOTE_PATH,
  frontmatter: {
    tags: ['ios-parity', 'testing', 'tech/typescript'],
    aliases: ['Parity Kitchen Sink'],
    author: 'Frank Herbert',
    rating: 4,
    deadline: seedDateOnly(LAUNCH_DAY),
    shared: true,
    url: 'https://memry.app',
    status: 'active',
    priority: 'high',
    format: ['Kindle', 'Audiobook'],
    related: [`memry://note/${NOTE_IDS.bookDune}`, `memry://note/${NOTE_IDS.bookDeepWork}`],
    project: ['memrynote Launch']
  },
  body: IOS_PARITY_BODY,
  modified: MODIFIED
}

/** Copies the note's attachments into `<vault>/attachments/<noteId>/`. */
export function writeIosParityAttachments(vaultPath: string): number {
  const target = resolve(vaultPath, 'attachments', ATTACHMENT_DIR)
  mkdirSync(target, { recursive: true })
  for (const name of IOS_PARITY_ATTACHMENTS) {
    copyFileSync(resolve(ASSET_DIR, name), resolve(target, name))
  }
  return IOS_PARITY_ATTACHMENTS.length
}

/** Byte size on disk, which the file markers must agree with. */
export function iosParityAssetSize(name: (typeof IOS_PARITY_ATTACHMENTS)[number]): number {
  return statSync(resolve(ASSET_DIR, name)).size
}
