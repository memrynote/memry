import { toWritingFrontmatterValue, type WritingFrontmatter } from '@memry/shared'
import type { NoteFile } from '../seed-vault/file-writer'
import { seedPastISOAt } from './date'
import { NOTE_IDS } from './notes'

// ============================================================================
// Writing tools demo — "Why memrynote keeps your drafts".
//
// Alternatives, ghosts and overflow live in the markdown file like everything
// else (packages/shared/src/writing-tools/markdown.ts): comment markers in the
// body say where each range is, and the `writing` frontmatter key holds the
// other versions and the overflow list. The app builds its Y.Doc records from
// the file on first open, so the seed only writes the file.
// ============================================================================

export const WRITING_DRAFTS_NOTE_PATH = 'projects/Why memrynote keeps your drafts.md'

/** Ids the body's markers and the frontmatter share. */
const ALT_HEADING = 'hd7q2kxa'
const ALT_QUIET = 'qt4m9cze'
const ALT_SENTENCE = 'sn8r1wvb'

/** The sentence alternative shows a variant: this is in the body, the original is not. */
const SENTENCE_SHOWN = 'Choosing between two versions is easier when both are still on the page.'
const SENTENCE_ORIGINAL =
  'It is much easier to choose a sentence when you are not forced to throw the other one away first.'

export const WRITING_DRAFTS_BODY = `I have deleted more good sentences than I have kept. Not because they were wrong, but because the editor in front of me had room for one version of each thought, and the newest one always won. Most of the time that is fine. Some of the time the better line is gone before I notice it was better.

This post is about the small set of writing tools in memrynote, and why they work the way they do. The short version: the app keeps your drafts, because drafting is where the thinking happens.

# <!--alt:${ALT_HEADING}-->Drafts are where the thinking happens<!--/alt:${ALT_HEADING}-->

## One calm place

I want memrynote to feel <!--alt:${ALT_QUIET}-->quiet<!--/alt:${ALT_QUIET}-->. Notes, tasks, a journal and a calendar share one window, and none of it should compete for your attention. A writing tool that fills the margin with suggestions you did not ask for breaks that, so nothing here speaks until you ask.

Other tools taught me what I did not want. <!--ghost-->I could fill a page with every editor I have tried and left, and maybe one day I will.<!--/ghost--> What they had in common was urgency: a blinking prompt, a score, a nudge to write more.

## Privacy is the product

Your notes live on your device first. memrynote keeps them in a local database and in plain markdown files you can open with anything, and it works with no network at all. When you turn sync on, everything is encrypted on your device before it leaves, with keys the server never sees. The server stores ciphertext and timestamps, and that is all it can know.

The writing tools follow the same rule. Alternatives, ghosts and overflow belong to the note, so they sync with it and are encrypted with it. They go nowhere the note does not go.

> If the server can read your notes, they are not really your notes.

## Every feature is a toggle

A notes app tends to grow until it is a dashboard. I would rather it stay small and let you decide what is switched on. The writing tools are three buttons in the note chrome: Alternatives, Overflow and Lab. Leave them off and the editor is just an editor<!--ghost-->, which is how I write most days<!--/ghost-->. Turn one on and its panel opens beside the note, one at a time.

## How drafting works

### Keep alternatives instead of deleting

When I am unsure about a word, I used to rewrite it, read it, rewrite it again, and lose the first try each time. Now I select it and add an alternative. The original stays listed, my other versions sit next to it, and I can swap between them in place to read each one in context.

<!--alt:${ALT_SENTENCE}-->${SENTENCE_SHOWN}<!--/alt:${ALT_SENTENCE}-->

### Ghost instead of cut

Some text is not wrong, it is just in the way. Ghosting fades it out without removing it, so I can read the paragraph as if it were gone and bring it back if the paragraph turns out to need it. Ghosted text is left out of the word count, which keeps the count honest while I decide.

### Overflow instead of a pile at the bottom

Every draft I have written had a heap of fragments at the bottom: a paragraph I cut, a phrase I liked, an outline from the first hour. That heap gets exported, synced and published by accident. Overflow is a list beside the note for exactly that material. It travels with the note but is not part of the body, so it never ends up in an export or a published post.

The loop I use most days:

1. Write the paragraph badly and quickly.
2. Add alternatives to the words I doubt, and keep going.
3. Ghost anything that reads like throat-clearing.
4. Move the leftovers to overflow, then read the whole thing once more.

> [!info]
> Alternatives, ghosts and overflow are saved in the note's markdown file, so they go wherever the file goes. Other apps show the text exactly as it reads now.

In the file, a range is a pair of HTML comments around the text, which other markdown apps hide. The versions you are not showing, and the overflow list, sit in the frontmatter:

\`\`\`yaml
writing:
  alternatives:
    qt4m9cze:
      versions: [calm, still, {text: restful, ai: true}]
  overflow:
    - label: Words I like
      text: unhurried, beside, keep
\`\`\`

## Crafted, not corporate

What I try to hold to:

- No streaks, badges or reminders to write more.
- No AI text in your note unless you put it there. Lab underlines and dims; it never rewrites.
- Plain files you can take with you.

## Earn trust through restraint

Restraint is hard to demo. A tool that stays out of the way looks like less in a screenshot. But the moment that matters is the one where you go back for the sentence you almost deleted, and it is still there.

***

Before I publish a post:

- [x] Read it once with every ghost hidden {check}
- [x] Pick one version of each alternative {check}
- [ ] Empty the overflow, or decide to keep it {check}

That is the whole idea. Keep the draft, keep it on your device, and keep the tools out of the way until you reach for them.`

/** The `writing` frontmatter: the versions not on show, and the overflow list. */
export const WRITING_DRAFTS_WRITING: WritingFrontmatter = {
  alternatives: {
    [ALT_HEADING]: {
      versions: [
        { text: 'The draft is the thinking' },
        { text: 'Keep the draft, not just the result' }
      ]
    },
    [ALT_QUIET]: {
      versions: [
        { text: 'calm' },
        { text: 'still' },
        { text: 'unhurried' },
        { text: 'restful', ai: true },
        { text: 'settled', ai: true }
      ]
    },
    [ALT_SENTENCE]: {
      original: SENTENCE_ORIGINAL,
      versions: [{ text: SENTENCE_SHOWN }]
    }
  },
  overflow: [
    {
      label: 'Spare paragraph',
      text: 'I tried a version of this post that opened with a story about losing a chapter to a bad save. It was true, but it made the post about fear, and this is not a post about fear.'
    },
    {
      label: 'Words I like',
      text: 'unhurried, beside, keep, restraint, plain files, room for one version'
    },
    {
      label: 'Outline',
      text: '1. The sentence I deleted\n2. One calm place\n3. Privacy is the product\n4. Every feature is a toggle\n5. How drafting works\n6. Restraint'
    },
    {
      label: 'Quote',
      text: '"I have made this longer than usual because I have not had time to make it shorter." Blaise Pascal, Provincial Letters'
    }
  ]
}

const MODIFIED = seedPastISOAt(-1, 21, 40)

export const WRITING_DRAFTS_METADATA = {
  id: NOTE_IDS.writingDrafts,
  path: WRITING_DRAFTS_NOTE_PATH,
  title: 'Why memrynote keeps your drafts',
  emoji: null,
  createdAt: seedPastISOAt(-4, 9, 10),
  modifiedAt: MODIFIED
}

export const WRITING_DRAFTS_NOTE: NoteFile = {
  relativePath: WRITING_DRAFTS_NOTE_PATH,
  frontmatter: {
    tags: ['projects/memry', 'writing'],
    project: ['memrynote Launch'],
    writing: toWritingFrontmatterValue(WRITING_DRAFTS_WRITING)
  },
  body: WRITING_DRAFTS_BODY,
  modified: MODIFIED
}
