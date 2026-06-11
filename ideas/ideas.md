# Ideas

## Content Table

- [Reduce filing with AI-assisted capture](#reduce-filing-with-ai-assisted-capture)
- [Contextual resurfacing by relevance](#contextual-resurfacing-by-relevance)
- [Inbox segmentation and triage](#inbox-segmentation-and-triage)
- [Structure without folder rigidity](#structure-without-folder-rigidity)
- [Google Docs for markdown files](#google-docs-for-markdown-files)
- [One-way Google Calendar sync](#one-way-google-calendar-sync)
- [Streamlined onboarding without AI noise](#streamlined-onboarding-without-ai-noise)
- [Import from other note apps (Google Keep first)](#import-from-other-note-apps-google-keep-first)
- [Scheduled review and priority buckets](#scheduled-review-and-priority-buckets)

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

## One-way Google Calendar sync

Source: app feedback from Aurelie Kabore asking for a one-way Google Calendar sync
option.

### User signal

She wants tasks and appointments to live in MemryNote, but only appointments to push
out to Google Calendar. Today the sync is two-way, so anything with a date — both
appointments and tasks that have a due date — flows to Google and stays in step in both
directions. She wants tasks to stay private to MemryNote while still surfacing
appointments in Google.

Her follow-up spelled out the workflow behind this. The task manager is the daily
driver: she looks at it to know what she is doing today. The calendar is for
availability only — when she is free for meetings — and never for tasks. She runs a
one-way feed from Google Calendar into her task manager so appointments show up
alongside tasks in one place. MemryNote's two-way push is the inverse direction of how
she works.

The deeper reason two-way is a problem: her dated tasks are flexible, not commitments.
She may schedule a task for a given day at the start of the week, but that is a "would
like to" not a "have to" — subject to change. Pushing those tentative, movable tasks
into the calendar makes it messy and misrepresents her real availability. Due dates
stay valuable in the task manager; they should just never leave it.

### Current behavior

- Sync is two-way: appointments and dated tasks both flow to Google Calendar and stay
  in step in both directions.
- A task only syncs to Google if it has a due date. Tasks without a due date never
  leave MemryNote.
- Workaround available today: keep due dates off tasks to get the appointments-only
  split, but that gives up due dates as a feature.

### Product direction

Add an explicit sync-direction and scope control instead of relying on the
no-due-date workaround:

- One-way (push only): MemryNote → Google Calendar, no inbound changes.
- Item-type scope: choose what pushes out — appointments only, tasks only, or both.
- Per-calendar mapping so appointments and tasks can route to different Google
  calendars or stay local.
- Keep two-way as the default; make direction and scope a clear, visible setting.

### Follow-up validation

Aurelie replied with the full workflow above (task manager as daily driver, calendar
for availability only, flexible due dates that should not clog the calendar). Confirmed
her workflow is valid and not an edge case, and committed to ship one-way /
appointments-only sync before launch — direction is a real, supported control, not just
the no-due-date workaround. Scope is now well understood; this moves from "on the list"
to a launch-blocking commitment.

### Important boundary

Do not silently change what syncs. Direction and item-type scope must be explicit and
visible, so users always know what leaves MemryNote and what stays local. Tasks should
never appear in Google Calendar unless the user opts in.

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

## Import from other note apps (Google Keep first)

Source: Reddit feedback from a user who dumps random notes into Google Keep and wants
to bring them into MemryNote.

### User signal

The user has a tendency to dump random notes into Google Keep — sometimes continuous
prose, sometimes a to-do list — and wants to import and sort those into MemryNote.

### Product direction

- Build import for several note apps, with Google Keep as one of the first supported
  sources.
- Handle both shapes Keep produces: continuous free-text notes and checklist / to-do
  notes.
- Imported items should land in the inbox for triage rather than auto-filing, so the
  user decides what becomes a note, task, or reference. This reuses the inbox
  segmentation and triage model.

### Important boundary

Import should not silently scatter content across the app. Bring it in as reviewable
material the user can sort, consistent with the capture-then-triage model.

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

### Important boundary

Do not force the user to prioritize at capture time — that reintroduces the friction
the workflow is meant to remove. The scheduled review is a prompt to process, not an
automated sorter; the user stays in control of what goes where. The reminder should be
a gentle nudge, not nagging.
