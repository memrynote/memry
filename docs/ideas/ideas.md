# Ideas

_Each idea is collapsed by default — click a title to expand it._

<details>
<summary><strong>Reduce filing with AI-assisted capture</strong></summary>

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

</details>

<details>
<summary><strong>Contextual resurfacing by relevance</strong></summary>

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

</details>

<details>
<summary><strong>Inbox segmentation and triage</strong></summary>

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

</details>

<details>
<summary><strong>Structure without folder rigidity</strong></summary>

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

</details>

<details>
<summary><strong>Streamlined onboarding without AI noise</strong></summary>

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

</details>

<details>
<summary><strong>Scheduled review and priority buckets</strong></summary>

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

</details>

<details>
<summary><strong>Bulk URL import via CSV</strong></summary>

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

</details>

<details>
<summary><strong>Second-device setup should adopt the existing vault</strong></summary>

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

</details>

<details>
<summary><strong>Fixed-page notebooks with custom covers</strong></summary>

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

</details>

<details>
<summary><strong>Spatial canvas for brain-dump thinking</strong></summary>

Source: email thread with Matt McMahon (current Heptabase user, found MemryNote via a
Medium post), 2026-07-16. He asked whether a spatial thinking sandbox is on the roadmap,
then described in detail how he actually uses Heptabase's whiteboard.

### User signal

Matt lives inside Heptabase's whiteboard — it is his primary surface for study materials
(organized by subject), project planning, and working through what he is learning. He
ranges widely: C++ / 3D game engines, Python / AI models, philosophy, psychology. His
Readwise highlights get referenced on his boards. The whiteboard's core value for him is
the ability to do massive brain dumps without being forced to classify or organize up
front. He is explicit that he cannot stick with tools that make him categorize early —
his natural inclination is to not care about structure at capture time, and any system
that forces it "usually doesn't see much usage."

His workflow is capture-then-connect: dump cards freely while thinking, then later link
cards together into a "web of knowledge." This is the same capture-fast / organize-later
pattern already documented in [Scheduled review and priority buckets], expressed
spatially instead of as a list.

### How Matt uses Heptabase's canvas

- Everything on one surface: subjects, projects, and learning details all live as cards.
- Mixed media per card: audio, video, PDF, plus block types — code, LaTeX for equations,
  text. Fast to drop a block of any type without stopping to think.
- Card-to-card linking after the fact to build the knowledge web, not up front.
- Rapid topic-switching: one minute C++, the next Python / AI, the next philosophy notes.
  The canvas holds all the scattered contexts at once so he can jump between them.
- Least-used features: AI integration (second-to-last) and collaboration / sharing
  (last) — he has no need to share his boards with anyone.

### The performance wedge (his number-one complaint)

Matt's single biggest frustration with Heptabase is whiteboard performance. His largest
boards — many cards plus images and videos — "lag to hell and back." Heptabase's advice
was to split into sub-whiteboards; he does not want to segment his thinking just to work
around a rendering limit. This is the clearest opening for MemryNote: a canvas that stays
smooth at high card and media counts is a direct, concrete reason for heavy Heptabase
users to switch. Performance at scale should be a design constraint from day one, not a
later optimization pass — virtualized / culled rendering, lazy media loading, and
thumbnail or proxy images for off-screen cards. MemryNote's offline-first, local-SQLite
footing is an advantage here.

### Product direction

This expands the one-line "Visual workspaces" bullet under [Structure without folder
rigidity] into a real concept. The guiding rule from that section still holds: the canvas
links to real notes, it does not become a separate knowledge silo.

- Cards are notes, not a parallel store. A card is a spatial view of a real note or block
  on disk, so anything created or linked on the canvas stays a portable Markdown note and
  keeps showing up in search, backlinks, tags, and folders. No second database.
- Brain-dump-first capture: let the user drop a card straight onto the canvas with zero
  filing — no folder, no tag, no decision — matching MemryNote's capture-then-triage
  philosophy. Promotion into a filed note happens later, if ever.
- Block and media parity by reuse: cards should render the same BlockNote surface notes
  already use — text, code, math / LaTeX, images, PDF, audio, video, YouTube — rather than
  a bespoke card editor. That is how MemryNote matches Heptabase's "any block, instantly"
  feel without rebuilding it.
- Spatial links are wiki links: card-to-card connections are the existing link / backlink
  graph, drawn on the canvas. The "web of knowledge" becomes a manual, spatial layer over
  relationships MemryNote already tracks.
- Ship what he reaches for, defer what he skips: he ranks AI and collaboration lowest.
  Launch the calm single-player canvas first; do not front-load AI suggestions or
  real-time multiplayer.

### Adjacent asks from the same thread

- Calendar sync: he wants his notes and canvas to help hold his days together. MemryNote
  already has calendar events, so a dated card or note surfacing on the calendar is a
  natural tie-in rather than new infrastructure.
- More native integrations plus a dev API / community package marketplace: he trusts
  native integrations over AI and wants easier ways to push data between apps (he already
  uses Heptabase's MCP server, and loves the Readwise integration). This aligns with the
  MCP-first Agent Chat direction and the Vault MCP server — lead with an integration / MCP
  story rather than committing to a plugin marketplace. A Readwise import specifically
  would land well with this segment.

### Important boundary

The canvas must stay a spatial view over real notes, never a separate silo with its own
hidden data model — that is the trap that turns a whiteboard into a second inbox nobody
reconciles. Performance at scale is the actual product here, not the length of the block
list; if a large board lags, it fails the exact user it is meant to win. And it has to
fit the calm, one-place register — a place to think, not another surface to maintain.
Treat AI and collaboration as later layers, not launch requirements.

</details>
