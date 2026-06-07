# Ideas

## Content Table

- [Reduce filing with AI-assisted capture](#reduce-filing-with-ai-assisted-capture)
- [Contextual resurfacing by relevance](#contextual-resurfacing-by-relevance)
- [Inbox segmentation and triage](#inbox-segmentation-and-triage)
- [Structure without folder rigidity](#structure-without-folder-rigidity)
- [Google Docs for markdown files](#google-docs-for-markdown-files)

## Reduce filing with AI-assisted capture

Source: weekly email feedback mentioning [Granite](https://granite.co/) and
[Screenpipe](https://screenpipe.com/).

### User signal

If MemryNote becomes a personal "life OS", filing should almost disappear. The user
does not want to keep manually deciding where every captured item belongs.

### Product direction

Use capture tools and AI to reduce filing work without turning MemryNote into a
passive dump.

The first version can still be a web clipper:

- Fetch useful web context.
- Put it into the inbox.
- Let the user decide what to keep, turn into a note, convert into a task, or discard.

The longer-term direction should feel closer to an AI assistant:

- Capture relevant context from the web or the user's workflow.
- Suggest where it belongs.
- Suggest note, task, reminder, or reference actions.
- Keep the user in control with approve, edit, or ignore choices.

### Important boundary

AI should not automatically file everything. If all filing is fully automatic, the
system can become noisy and ineffective. The goal is not to save more data. The goal
is to make the right context useful later with less manual work.

Screenpipe-style passive capture is interesting, especially if it can stay local-first
and privacy-respecting, but it needs strong filtering and review. MemryNote should act
like a careful assistant, not an automatic hoarder.

## Contextual resurfacing by relevance

Source: second weekly email reply about Tana `#idea`, Raindrop, and intentionally
recalling saved material.

### User signal

The user currently needs scripts, tags, and random resurfacing tools to recall old
ideas and saved links. Having this happen in one place is a clear subscription-positive
signal.

The most important factor is relevance to the current topic. Exact matching rules are
hard to define: matching words, similar contexts, and tags may all help, but the user
wants older notes to come back while writing new ones without needing to remember to
look for them.

### Product direction

MemryNote should resurface old notes and saved material from the current writing
context first, using semantic/topic relevance instead of simple keyword-count matching.

Tags should act as a fallback and reinforcement layer when the current note has weak or
ambiguous semantic matches.

Useful resurfacing should be lightweight:

- Show why an old note or saved item was suggested.
- Prefer a few high-confidence suggestions over a noisy feed.
- Let the user dismiss, save, link, or ignore without breaking writing flow.

### Important boundary

Do not make resurfacing feel random by default. Serendipity is useful only when it is
anchored to the current topic, active project, or tags.

## Inbox segmentation and triage

Source: third weekly email feedback from Damian Newton about the Tasks component,
Inbox workflow, and where the Agent fits.

### User signal

The Inbox reads as a collection space, but the workflow needs to be explicit. Captured
items should not stay as a flat pile. Users should be able to turn inbox items into
the thing they actually represent: task, calendar event, note, reminder, reference, or
discarded noise.

### Product direction

Make Inbox the triage layer between raw capture and the rest of MemryNote.

Each inbox item should have a clear next action:

- Convert to task when the item has an action, owner, priority, or due date.
- Convert to calendar event when the item belongs to a specific time window.
- Convert to note when the item is context, thinking, meeting notes, or reference
  material.
- Convert to reminder when the item should come back later but is not a full task yet.
- Keep as reference when the item is useful but does not need immediate processing.
- Archive or discard when the item is no longer useful.

The inbox view should support segmentation without forcing users to decide everything
up front:

- Unprocessed: newly captured items that need review.
- Suggested tasks: items with action language, dates, assignees, or follow-up wording.
- Suggested calendar: items with dates, times, meetings, or deadlines.
- Suggested notes: longer context, clipped material, meeting summaries, or ideas.
- Snoozed: items intentionally deferred for later review.
- Done or archived: processed items kept out of the active inbox.

### Agent role

The Agent should help with triage, not own it.

Useful Agent actions:

- Detect likely tasks, events, notes, and reminders from unprocessed inbox items.
- Suggest the best destination and explain the reason briefly.
- Extract task titles, due dates, and source context from messy captures.
- Turn meeting notes or long captures into linked tasks and a cleaned-up note.
- Batch process selected inbox items with approve, edit, or ignore controls.
- Resurface old inbox items when they become relevant to a current note, project, or
  calendar date.

The Agent should feel like a review assistant inside the workflow, not a separate chat
surface that requires the user to restate what is already in the inbox.

### Important boundary

Do not make the Inbox another permanent database. It should be a temporary processing
surface. The product goal is not to classify everything perfectly. The goal is to help
users move captured material into the right durable place with minimal admin and clear
user control.

## Structure without folder rigidity

Source: weekly email feedback from Aurelie Kabore about moving between Notion,
Obsidian, Capacities, Anytype, and wanting more flexible organization for visual
thinking.

### User signal

Folders are useful for organizing, but they feel rigid. The user wants notes to
belong to more than one mental place, closer to object-based apps and tag-built
collections, while still keeping Markdown portability.

She also values comments, hover previews, visual navigation, embedded media,
multiple open tabs, and the ability to connect notes into a trail of thinking.

### Already covered or mostly covered

- Wiki links and backlinks make notes clickable and connected.
- Tags and properties support discovery beyond folders.
- Folder views act like database-style collections over notes.
- Tabs and split panes support working with several notes at once.
- Images, PDFs, audio, and YouTube embeds cover the core media-preview need.
- BlockNote supports text/background color highlighting for selected text.

### Product gaps and ideas

- Smart collections: tag/property/search-based collections that can be saved,
  named, and shown as first-class sidebar items. A note can then appear in
  multiple collections without moving its Markdown file.
- Manual collections: user-curated note sets for projects, topics, or MOCs,
  separate from the physical folder path.
- Subnote-like structure: support a note-owned outline of child notes or
  related notes without copying Notion's page/subpage model or breaking Markdown
  portability.
- Broader hover previews: not only wiki links and tabs, but backlinks, search
  results, graph nodes, and collection rows.
- Visual workspaces: canvas or whiteboard surface that links to real notes
  instead of becoming a separate knowledge silo.
- Native video preview: local video attachments should be viewable inline, not
  only as file/download blocks.
- PDF annotation and visual markup: useful for visual people who work from
  source material.
- Comments and suggestion mode polish: make note/journal comments feel
  first-class with mentions, attachments, and an anchored right-side review
  surface.

### Follow-up validation

Aurelie's reply confirmed that the existing tags, links, backlinks, and properties
model is clear. She also accepted the subnote direction as long as MemryNote keeps a
freeing structure without copying Notion, and she understood the canvas tradeoff.
Color highlighting and the comments screenshot both landed positively.

### Important boundary

Do not make MemryNote a Notion clone. The goal is flexible organization on top of
portable local notes: folders for disk structure, links for relationships, tags
and properties for grouping, and collections for saved perspectives.

## Google Docs for markdown files

Source: Kaan's product note, June 2026.

### User signal

"I need Google Docs but just for markdown files." The collaboration workflow people
already trust in Google Docs — comments, suggestions, history — but on top of portable
local Markdown instead of a proprietary document silo.

### Product direction

Bring the Google Docs collaboration loop to Markdown notes:

- Multiplayer comments: comment threads that sync across devices and collaborators,
  including resolving comments and keeping the resolved state in sync.
- Suggestion mode: propose edits without changing the underlying text until accepted,
  building on the existing CriticMarkup review surface.
- Edit mode: the normal direct-editing default, with a clear switch between editing
  and suggesting.
- Edit history: see how a note changed over time and who changed it.
- Some sense of multi edits: multiple pending edits/suggestions on the same note that
  can be reviewed and applied individually or together.
- Easy CLI access: the same notes and collaboration state reachable from the command
  line, not only the desktop app.

### Important boundary

The files stay plain Markdown on disk. Collaboration metadata (comments, suggestions,
history) must not break portability — a note opened outside MemryNote should still be
a readable Markdown file.
