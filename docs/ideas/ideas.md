# Ideas

## Content Table

- [Reduce filing with AI-assisted capture](#reduce-filing-with-ai-assisted-capture)
- [Contextual resurfacing by relevance](#contextual-resurfacing-by-relevance)
- [Inbox segmentation and triage](#inbox-segmentation-and-triage)
- [Structure without folder rigidity](#structure-without-folder-rigidity)
- [Streamlined onboarding without AI noise](#streamlined-onboarding-without-ai-noise)
- [Scheduled review and priority buckets](#scheduled-review-and-priority-buckets)
- [Bulk URL import via CSV](#bulk-url-import-via-csv)
- [Second-device setup should adopt the existing vault](#second-device-setup-should-adopt-the-existing-vault)
- [Fixed-page notebooks with custom covers](#fixed-page-notebooks-with-custom-covers)

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

## Streamlined onboarding without AI noise

Source: Reddit feedback comparing MemryNote favorably to Saner AI, but put off by
Saner's onboarding and how verbose its AI is.

### User signal

The user found MemryNote close to exactly what they need, but bounced off Saner AI's
onboarding. Saner generated prompts like "Pull 3 concrete measurable goals for
cross-team collaboration you can use in the next sync" before the user had entered
anything. That generic, corporate AI verbiage felt repulsive and pushed them away. They
asked directly whether MemryNote has thought about a streamlined onboarding.

### Product direction

- Keep onboarding short and concrete. Get the user to their own notes and tasks fast,
  not through AI-generated busywork or fake example goals.
- Do not generate unprompted AI suggestions before the user has put anything in. AI
  should respond to real user content, never invent filler to perform intelligence at
  an empty app.
- Keep the AI footprint deliberately small for now. Add AI one piece at a time, driven
  by real feedback, instead of bolting it onto every surface because it is the current
  hype.

### Important boundary

AI must stay quiet and useful, not chatty and needy. The edge here is restraint: an
empty app should feel calm. This positioning is a feature, not a gap.

## Scheduled review and priority buckets

Source: Reddit feedback describing a capture-fast, organize-later workflow with
do-now / do-soon / long-term priorities.

### User signal

The user wants to jot things down quickly and get back to work, then continue and
organize the thought later. Concretely: dump items through the day without deciding
what they are, then at a set time each day (for example 6pm) get a reminder to sit down
and process that pile — turning items into tasks sorted into priority buckets.

Their own framing: "I need to-dos bucketed into 'do now', 'do soon', and 'long term',
but so that I don't fail to do the long-term stuff by constantly doing one short-term
task after another. Easily turning notes into reminders would be good."

The core pain is not routing — it is prioritization over time. Long-term items quietly
rot while the user grinds an endless queue of short-term tasks.

### Product direction

- Separate capture from classification in time. Capture stays instant and
  type-agnostic — no bucket, no date, no decision at jot time. Items land in the inbox.
  This builds directly on inbox segmentation and triage.
- Add a scheduled review: an optional daily reminder at a user-set time (for example
  6pm) that nudges the user to process the day's captures in one calm pass.
- During review, let items be sorted into priority buckets — do now / do soon / long
  term — as a priority axis distinct from the task / note / event destination type.
- Protect the long-term bucket from neglect: keep long-term items in view, resurface
  them, and nudge dated ones so they do not get buried under short-term churn.
- Make turning a note into a reminder a one-step action.
- Add a focus mode for the short-term list: the user hand-ranks tasks by dragging them
  up or down, then hits "Go" to enter a one-task-at-a-time feed that brings the top
  task to the fore with its subtasks inline and says, in effect, "this is what to do
  right now."
- Show a small "Next task" peek in a corner of focus mode — just the next task's name —
  as a gentle prod not to over-spend on the current one.
- The focus feed must follow the user's manual rank order, never auto-sort by date or
  priority. A "do now" task added today must not automatically outrank a "do now" task
  carried over from yesterday; relative urgency is the user's call, set by dragging.

### Follow-up: what already exists

Source: Reddit follow-up refining the do-now / do-soon model into a hand-ranked focus
feed with a next-task nudge.

Most of this substrate already exists in the task system, so the new work is a thin
view, not a data-model change:

- Manual ranking is already supported — tasks have a `position` field with a
  `reorderTasks` command and drag-and-drop reordering UI.
- Subtasks are already modeled (parent / child) and rendered.
- A Today view plus overdue / upcoming queries already exist.

The genuinely missing pieces:

- A focus mode / single-task "do this now" feed — today there is only a task detail
  drawer, no focus view.
- A persistent "Next task" peek.
- Task-level reminders — reminders currently target notes, journals, and highlights,
  not tasks, so "turn this into a reminder" does not yet cover tasks.

Open design decision: whether do now / do soon / long term map onto the existing
numeric priority field, the per-project status columns, or a new dedicated axis. The
hand-ranked short-term list is orthogonal to whichever bucketing is chosen.

### Important boundary

Do not force the user to prioritize at capture time — that reintroduces the friction
the workflow is meant to remove. The scheduled review is a prompt to process, not an
automated sorter; the user stays in control of what goes where. The reminder should be
a gentle nudge, not nagging.

## Bulk URL import via CSV

Source: feature request asking for a CSV import button on the inbox page to bulk-add
URLs (for example YouTube links).

### User signal

The user already captures single links into the inbox. They want to bring in many links
at once — paste or upload a CSV of URLs (YouTube videos and similar) and have each row
land in the inbox, instead of adding links one at a time.

### Product direction

- Add a CSV / bulk-paste import on the inbox: one URL per row, each becomes an inbox
  item.
- Reuse the existing single-item link capture and parsing pipeline per row rather than
  building a separate path — same article/metadata extraction, just looped.
- Run extraction in the background and queue rows; the existing offline capture queue
  already handles retry and batching, so bulk import can ride on it.
- Surface per-row progress and failures (bad URL, fetch failed) without blocking the
  rest of the batch.
- Imported links land in the inbox for triage, consistent with the capture-then-triage
  model — no auto-filing.

### Important boundary

Bulk import must not hammer the network or duplicate items. Dedupe against existing
inbox items, throttle extraction, and keep the user able to cancel a large run.

## Second-device setup should adopt the existing vault

Source: customer email (2026-07-05) — installed MemryNote on a Fedora laptop, set up
sync, and expected the notes from their MacBook to appear. The app showed the correct
plan and "synced", but nothing pulled down.

### User signal

Users think of sync as per-account: sign in on a new device, notes appear. Sync is
actually per-vault, so setup on the new device mints a fresh empty vault and truthfully
reports "synced" — which reads as data loss to the user. The vault directory
("In your account" in the vault switcher) already solves this, but users don't know to
look for it. This exact confusion has now happened twice (once internally on
2026-06-08, now a real customer).

### Product direction

- During setup / first sign-in, check the account vault directory. If the account has
  existing remote vaults, offer to download one instead of silently creating a new
  empty vault.
- Single-vault accounts (the overwhelmingly common case) should auto-adopt or get a
  one-click "Pull down your existing vault" default; multi-vault accounts get a picker.
- If the user does want a fresh vault, that stays available — but as an explicit
  choice, not the silent default.
- Reuses the shipped vault-directory plumbing (`GET /sync/vaults`,
  `downloadRemoteVault`); the work is onboarding flow, not sync protocol.

### Important boundary

Never merge into or overwrite an existing vault automatically — adoption means
downloading into a clean local copy the user confirmed. And don't block setup on the
directory call: offline or empty-account users must still get a vault instantly.

## Fixed-page notebooks with custom covers

Source: Reddit post (r/Notetaking style) from a student starting school in September on
a Lenovo (Windows) laptop. Requirements: fixed pages (no infinite scroll / infinite
canvas), multiple notebooks (bonus: customizable cover), desktop-first, one-time
payment. They said they might fall back to annotating PDFs if nothing fits.

### User signal

The core want is a bounded-page layout — a page you fill, then flip to the next, with
visible page edges — plus a physical-notebook feel (named notebooks, custom covers).
The "make PDFs and use those" fallback and "customize the cover" bonus both point at
the paper-notebook metaphor, not a document editor.

MemryNote matches three of the four asks: cross-platform desktop (Windows / macOS /
Linux), multiple notebooks (vaults / folders), and a one-time Believer lifetime price.
The miss is the headline requirement. MemryNote's editor is a continuous block/Markdown
surface — one unbounded scrolling column per note — which is exactly the "infinite
scroll" layout the user ruled out. There is no bounded page, no page flipping, and no
notebook cover customization.

### What we don't have

- Fixed / paginated page layout — a bounded page surface (Letter / A4) with page breaks
  and flip-to-next, versus today's single continuous column per note.
- Notebook cover customization — a visual cover / identity per notebook (image, color,
  pattern, title), versus today's plain folder / vault entries.
- Handwriting and stylus ink — freehand note-taking on a 2-in-1, the implicit need
  behind a Lenovo student wanting paper-like pages.

### Product direction

This is a genuine category fork, so scope it honestly rather than chasing a GoodNotes
clone:

- Cheap and on-brand: notebook cover / identity (color, emoji or image, title) on
  vaults or top-level folders. Low cost, fits the calm, crafted register, and answers
  the "customize the cover" bonus directly.
- Medium: a paginated "page view" / print-preview toggle that renders a note into
  Letter / A4 pages with visible page breaks, for the fixed-page feel and clean PDF
  export — without changing how the note is stored on disk.
- Adjacent overlap: PDF annotation and visual markup (already listed under "Structure
  without folder rigidity") gives literal fixed pages for source material and partly
  serves the PDF fallback these users reach for.
- Likely out of scope: true handwriting / infinite-ink pages. That is a different
  product category and fights Markdown portability.

### Important boundary

Do not turn MemryNote into a handwriting / paged-document app. Markdown portability and
the continuous editor are core; fixed pages must stay a view or export concern, never a
change to how notes are stored. Treat this entry as a documented non-fit with a few
adjacent wins, not a roadmap commitment to page-based note-taking.
