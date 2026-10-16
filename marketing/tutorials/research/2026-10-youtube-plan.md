# memrynote on YouTube: benchmark and plan (October 2026)

This is a proposal for discussion. Nothing in it is built yet. It covers what the Evernote and Capacities channels
do, where the first memrynote tutorial stands, the series plan, the changes to the `tutorial-video` skill and
engine, and the YouTube upload automation.

The full channel analyses, with timestamps and quotes for every claim, are in
[2026-10-evernote.md](2026-10-evernote.md) and [2026-10-capacities.md](2026-10-capacities.md).

## 1. What was analyzed

| Source           | Evernote (@evernote)                            | Capacities (@CapacitiesHQ)                     |
| ---------------- | ----------------------------------------------- | ---------------------------------------------- |
| Catalog          | 328 videos, 27 Shorts, 26 playlists (2014–2026) | 48 videos, 32 Shorts, 3 playlists (2024–2026)  |
| Full metadata    | 118 items (last 3 years, plus every Short)      | 77 items (all)                                 |
| Benchmark videos | 14: transcripts, storyboard frames, thumbnails  | 14: transcripts, storyboard frames, thumbnails |
| Comments         | top 20 on 3 videos                              | top 20 on 3 videos                             |

Full metadata means exact dates, views, likes, comments, chapters, descriptions and tags. For 15 Evernote videos it
also includes the "most replayed" heatmap.

Limits:

- The agent cannot hear the voices. Tone was judged from the wording and the pace.
- Frames are YouTube storyboards: 320x180, one every 1–10 s. They show layout, zoom, presenters and overlays, but
  not small UI text.
- Watch time and click-through rate are private to each channel, so neither was available.
- **Both channels buy views.** Evernote's 2024–25 monthly recaps got 40–90k views with 1.1–1.8% likes. Unpromoted
  months of the same format got 6–8k. Capacities' September–October 2026 batch earns 200–613 views a day,
  against 10–30 a day for earlier videos of the same types. The analyses separate organic results from promoted
  ones using like ratio and comments per 1,000 views.

## 2. The channels in numbers

|                                | Evernote                                  | Capacities                           |
| ------------------------------ | ----------------------------------------- | ------------------------------------ |
| Subscribers                    | 147k                                      | 12.3k                                |
| Long-form uploads, last 12 mo  | 40                                        | 31                                   |
| Shorts, last 12 mo             | 2                                         | 30                                   |
| Median views, long-form, 12 mo | 3.9k                                      | 3.2k                                 |
| Median like ratio              | 2.1%                                      | 3.2%                                 |
| Videos with chapters           | 49%                                       | 85%                                  |
| Speech rate                    | 147–181 wpm in-house, 220+ for creators   | 170–215 wpm                          |
| On camera                      | presenters in recaps, creators in stories | face-cam bubble in 95–100% of frames |

### Formats, last 24 months, organic signal

Median duration is m:ss. Comments are per 1,000 views.

**Capacities**

| Format              | n   | Median views | Median duration | Likes | Comments | Note                              |
| ------------------- | --- | ------------ | --------------- | ----- | -------- | --------------------------------- |
| Start here          | 2   | 9.2k         | 5:43            | 2.0%  | 0.9      | both look promoted (Sep–Oct 2026) |
| Workflow / method   | 8   | 5.2k         | 13:48           | 2.7%  | 2.8      | GTD, PARA, capture-review         |
| Feature launch      | 4   | 5.1k         | 7:34            | 3.4%  | 5.1      |                                   |
| Feature tutorial    | 10  | 3.3k         | 9:09            | 2.9%  | 4.2      |                                   |
| Release walkthrough | 14  | 2.7k         | 7:32            | 4.2%  | 5.5      | most loyal audience               |
| Shorts              | 30  | 0.8k         | 0:16            | 1.9%  | 0.0      |                                   |

**Evernote**

| Format               | n   | Median views | Median duration | Likes | Comments | Note                    |
| -------------------- | --- | ------------ | --------------- | ----- | -------- | ----------------------- |
| Monthly recap        | 22  | 38k          | 5:53            | 1.7%  | 2.6      | promoted; 6–8k when not |
| Deep dive / tutorial | 4   | 19.8k        | 7:58            | 1.9%  | 1.9      | no sign of promotion    |
| Use-case story       | 2   | 4.5k         | 3:39            | 3.4%  | 3.0      | best like ratio         |
| Shorts               | 4   | 3.8k         | 0:39            | 2.0%  | 0.8      |                         |
| Weekly 16:9 clip     | 36  | 2.1k         | 0:42            | 2.6%  | 2.7      | high volume, low return |

## 3. Ten findings that change how we make videos

1. **Complete answers win.** The best organic videos answer one job end to end:
   - Evernote's "Spaces 101" (21k), "How to find and remember anything with Search" (18k) and "The ultimate guide to
     AI Assistant" (17k);
   - Capacities' "Introducing Task Management" (19.9k, 116 comments) and "How to Capture, Review, and Use Your
     Notes" (16.5k).

   The last one has no brand in its title, and its comments are full of people switching from Obsidian and Notion.

2. **Release videos serve existing users.** They draw the most likes and comments but stay at 3–6k views. They keep
   and activate users; they don't find new ones.
3. **Volume without packaging fails.**
   - Evernote's 36 weekly clips: 2.1k median.
   - Capacities' Shorts made from desktop recordings shrunk into a vertical frame: 778 median.
   - Shorts filmed on a phone, and one-liners cut from long videos: about 2k.
4. **Viewers skip talking intros.** On Evernote's heatmaps, a talking-head intro scores near zero replays. The peak
   lands on the second the demo starts (Customization, 0:42). Viewers use chapters as a menu.
5. **Hooks state a problem or a reason, never "subscribe".**
   - Capacities: "So you've set up your note taking app, but you're not sure how to use it consistently."
   - Evernote explains in four steps: the situation, the demo, the feature's name, then a one-sentence definition.
6. **Script devices that work:**
   - one running example that doubles as the agenda;
   - the problem before the fix;
   - rules of thumb;
   - forward references ("you'll see why later");
   - a closing recap that returns to the screen the video started on.
7. **Honesty is part of the style.** Plan requirements are said once, early. Limits are listed plainly: "Not at this
   time.", "not possible and it is not planned". The only call to action is "questions in the comments", and they
   follow through. Recurring tasks shipped after commenters asked for them, and a commenter's request became the
   Search deep dive.
8. **On screen:**
   - The app fills 80–95% of the frame on a branded background.
   - Evernote punches in 2–3x on every key moment and enlarges the cursor.
   - Capacities drifted to almost no zoom, and its wide shots are unreadable on a phone.
   - Full-screen text cards (bold black on white) carry the main idea for phone and muted viewers.
9. **Thumbnails.** Both channels run one template from their first upload:
   - a category label that matches the playlist;
   - one idea in 2–6 words, worded differently from the title;
   - a real UI crop;
   - faces only on videos about people.

   The template does not drive views on its own: identical Evernote recap thumbnails got 7.9k and 91k. Breaking the
   template ("115+") marks a video as special.

10. **Evernote's audience is looking for the door.** Top comments on the v11 launch:
    - price: "250 usd is too much" (71 likes);
    - AI fatigue: "not something I want anywhere near my personal notes" (52);
    - migration: "What's the best service to migrate to?" (16).

    Capacities' founder AMA drew four privacy questions. memrynote answers each of these:
    - it is local-first with end-to-end encryption;
    - AI is off by default and can run locally;
    - it imports ENEX, Notion and Obsidian.

## 4. Best examples to study

| Why                                    | Video                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| Job-first deep dive, verb-led chapters | Evernote, [How to find and remember anything with Search](https://youtu.be/12IzxOiku-Q) |
| Best organic tutorial                  | Evernote, [How to: Get organized with Evernote Spaces](https://youtu.be/ewHqC5gjQhc)    |
| Persona story                          | Evernote, [Liv's Italian study system](https://youtu.be/1In2ItR0sLM)                    |
| Half-year recap with 24 chapters       | Evernote, [115+ Improvements since v11](https://youtu.be/MrDkQYTy510)                   |
| Comments as a requirements list        | Evernote, [New Evernote Tasks experience](https://youtu.be/g_XaFnt_AeE)                 |
| Feature launch with an FAQ description | Capacities, [Introducing Task Management](https://youtu.be/u3za6T6iRt0)                 |
| Problem-first method video             | Capacities, [How to Capture, Review, and Use Your Notes](https://youtu.be/8ecdjdOqA5w)  |
| Tutorial                               | Capacities, [How to Organize Your Content, Part I](https://youtu.be/85rFpvl0pvM)        |
| Release walkthrough                    | Capacities, [Release 68](https://youtu.be/9TVL_y1HvbA)                                  |

## 5. Where our first film stands

`tasks-projects` runs 2:15, at -14.4 LUFS with a Scribe WER of 0.

**Already ahead of both channels:**

- The first action on screen comes at about 9 s. Evernote's long-form takes 15 s to 1:22, Capacities about 30 s.
- 148 wpm, the same pace as Evernote's tutorials.
- Exact captions, consistent loudness, and a seeded persona vault.
- SQL checks that prove the app did what the narration says. Neither channel has anything like them.

**Gaps:**

1. **Chapters may be rejected.** "Intro" runs 0:00–0:08, and YouTube requires at least 10 s per chapter.
2. **Wide shots are unreadable on a phone.**
   - UI text is about 15 px in the 1080p frame, about 5.5 pt on a phone held sideways.
   - Zooms are 1.45–1.9x, and the hub and board scenes have none.
   - The capture zoom cuts off both ends of the bar.
3. **The intro line gives no reason to watch.** "Here's how tasks and projects work in…" names the topic. It
   doesn't name a problem.
4. **Scenes say what, not why or when.** Each topic gets 13–16 s, against 31–86 s per chapter on both channels.
5. **The ending.** There is no closing question and no next video. The end card holds about 5 s, the minimum for
   YouTube end-screen elements.
6. **Packaging.** Chapter names are nouns ("Views"), not tasks the viewer wants done. The master is 1080p, while
   screen-recording channels commonly upload 1440p to get YouTube's sharper encodes. This is common practice, not a
   documented rule. The demo data has no images or files.

## 6. Series plan

### Playlists

| Playlist            | Job                                                                                             | Length    | Audience                            |
| ------------------- | ----------------------------------------------------------------------------------------------- | --------- | ----------------------------------- |
| Start here          | first hour                                                                                      | 10–12 min | new users                           |
| Tutorials           | one user job per video; small features become chapters, so wiki links live in the linking video | 3–7 min   | new and current users               |
| Switch to memrynote | import from another app, with honest limits                                                     | 4–6 min   | people searching for an alternative |
| Workflows           | a method or a person's week                                                                     | 6–12 min  | people searching for a method       |
| What's new          | one narrated walkthrough per release with three or more visible changes                         | 2–5 min   | current users                       |
| Shorts              | one trick each: a phone recording or a one-liner cut from a tutorial                            | ≤60 s     | discovery, low priority             |

The channel trailer is "memrynote at a glance", the overview another session is building in
`marketing/tutorials/demo/` (14 scenes, about 90 s). This plan links to it and does not repeat it.

### Videos

| #                       | Title (working)                                         | Folds in                                                                                                                              |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Start here**          |                                                         |                                                                                                                                       |
| S1                      | Getting started with memrynote                          | vault and first run, rail tour, first note, slash menu, one wiki link, capture, one task, today's journal, ⌘K search, the sync choice |
| **Tutorials**           |                                                         |                                                                                                                                       |
| T1                      | Write in the editor                                     | blocks, slash menu, formatting, tables, callouts, toggles, comments, export, version history                                          |
| T2                      | Link your notes                                         | wiki links, aliases, heading links, backlinks, graph, mind map                                                                        |
| T3                      | Organize with tags, properties and folder views         | tags, nested tags, properties, tags with fields, folder view, saved views                                                             |
| T4                      | Files, PDFs and media in your notes                     | attachments, PDF viewer, image crop, audio and video, OCR search                                                                      |
| T5                      | Capture everything                                      | inbox, triage, snooze, browser extension, global capture, voice memos                                                                 |
| T6                      | Tasks and projects (exists, to revise)                  | capture grammar, views, drawer, hubs, boards, tasks in notes                                                                          |
| T7                      | Tasks for power users                                   | filters, saved filters, bulk edits, recurrence picker, deep subtasks                                                                  |
| T8                      | Journal, templates and habit charts                     | daily entries, per-weekday templates, `/view` and `/chart` blocks, heatmap                                                            |
| T9                      | Plan your day                                           | Home, Day Panel, calendar, timeline, time blocking, Google, CalDAV and ICS                                                            |
| T10                     | Find anything fast                                      | ⌘K search, tabs, split view, shortcuts, hint mode                                                                                     |
| T11                     | Canvas with live notes and tasks                        | boards, live cards, arrows that become backlinks, sections                                                                            |
| T12                     | AI on your terms                                        | off by default, local models, inline menu, semantic search, Agent Chat, approvals, locks                                              |
| T13                     | Sync, devices and end-to-end encryption                 | goes offline, keeps working, syncs; device linking; recovery phrase; conflicts                                                        |
| T14                     | memrynote on iPhone                                     | free without an account, inbox and share sheet, tasks, journal                                                                        |
| T15                     | CLI and MCP for power users                             | `memrynote` commands, `--json`, the MCP server                                                                                        |
| **Switch to memrynote** |                                                         |                                                                                                                                       |
| M1                      | Leaving Evernote? Move your notes and keep them private | ENEX import and its stated limits, tags, notebooks, tasks                                                                             |
| M2                      | Switch from Notion                                      | HTML export import, what maps to what                                                                                                 |
| M3                      | Bring your Obsidian vault                               | the same Markdown files, wiki links, Obsidian Tasks                                                                                   |
| M4                      | Move from Apple Notes and Bear                          | both importers                                                                                                                        |
| **Workflows**           |                                                         |                                                                                                                                       |
| W1                      | Maya's week: a freelancer runs her clients in memrynote | story film on the tutorial vault persona                                                                                              |
| W2                      | A 15-minute weekly review                               |                                                                                                                                       |
| W3                      | Getting Things Done in memrynote                        |                                                                                                                                       |
| W4                      | PARA in memrynote                                       |                                                                                                                                       |
| W5                      | From reading to writing                                 | clip, triage, link, write                                                                                                             |
| W6                      | Meeting notes that turn into tasks                      |                                                                                                                                       |
| W7                      | A private second brain that works offline               |                                                                                                                                       |

### Order

1. **Wave 0, before the first upload:**
   - the channel setup;
   - the chapter fix;
   - phone-legible picture;
   - the script rules;
   - the thumbnail generator;
   - the description generator.

   The upload script can follow in wave 1. Until then, Kaan uploads by hand with the generated metadata.

2. **Wave 1, the launch set:** S1, T6 (revised), M1, T5, T2.
3. **Wave 2:** T1, T8, T9, T13, M2, M3, W1.
4. **Wave 3:** everything else, reordered by what the comments ask for.
5. **What's new:** from the first release after launch.

### Cadence and budget

- One long-form video a week, plus a What's new video when a release qualifies.
- A 6-minute film is about 5,400 narration characters, or about 11k with two takes. A weekly film plus two What's
  new videos comes to roughly 55k characters a month.
- ElevenLabs Starter allows 40k, so a weekly cadence needs the next plan up.

## 7. Skill and engine changes

Another session currently has uncommitted edits in `engine/compose.py` and `vault/seed.mjs`, so engine work waits
for that branch.

**Script rules** (`narration.json`, skill text):

- An intro line of at most 6 s that names a problem or a promise, for example: "A task should take seconds to capture
  and land where you'll see it."
- Each scene follows situation, demo, name, then a one-sentence definition, in one running example (Maya) told out
  loud.
- Plan requirements once and early. Limits as plain "Not yet" lines.
- Show the privacy promise on screen instead of only saying it in the outro.
- The outro is a one-line recap, then a specific question for the comments, then the next video, named only if it
  exists. Never ask for likes or subscribes.

**Picture:**

- Zoom of at least 2x (2.2–2.6x) on every line that names UI, centered so chips are not cropped. That includes the
  hub and board scenes.
- A phone-size QA still, 390 pt and 844 pt wide.
- A 1440p master.
- An optional phrase-triggered full-screen text card, for ideas that need to land on a muted phone.
- Logo lead cut from 1.6 s to about 0.6 s.
- An end card that holds 10–12 s, with room for YouTube's end-screen elements.

**Chapters and description:**

- Merge "Intro" into the first chapter, and validate the YouTube rules: first at 0:00, at least 3, each at least
  10 s.
- Verb-led chapter names: "Capture a task with date, priority, project and tag".
- A generated description: a job-first summary, then chapters, "Not yet" lines, the docs link, a download link with
  UTM, a feedback link, and the next video.
- Titles name the job and stay under about 70 characters, with the brand last or left out. The thumbnail text
  differs from the title.

**Thumbnail generator:** a `card.html` thumbnail mode.

- It uses the film's orange gradient and a real UI crop from a zoom still.
- The keyword is drawn as a memrynote chip (`+project`) or an orange highlight.
- A label pill matches the playlist (Tutorial, Switch, Workflow, What's new), plus a 2–5-word promise and the mark.
- Two layouts get prototyped: headline-left with UI-right like Evernote, and UI-top with a band like Capacities.
  Kaan picks one.
- It renders three variants for YouTube's Test & compare.
- QA checks it at 168x94 and 320x180.

**Publishing:** `engine/publish.mjs`, outside the default build, run only when Kaan asks. See section 8.

**What's new:** a tutorial-engine film per release, one scene and one chapter per feature. The `release-video`
showreel (40–60 s, music only) stays the teaser for X and the landing page, and can open the walkthrough or run as
a Short.

**Shorts** (low priority): 9:16 crops of the raw recording around each zoom target, with burned-in captions, plus
recordings from the iPhone app. Never shrink desktop UI into a vertical frame.

**Distribution:**

- Embed each tutorial in its docs page; most pages still have screenshot placeholders.
- Link it from the app's help and onboarding, the release notes and the beta update email.
- Pin the closing question as a comment.

## 8. Upload automation

All facts below are from the official docs; the references are in the research notes. The API pages were updated
2026-10-15.

**One-time setup**

1. **Create the channel** as a Brand Account.
   - Phone verification unlocks custom thumbnails and videos over 15 minutes.
   - Advanced features unlock manual chapters and thumbnail A/B tests. They need ID or video verification, or
     channel history.
   - Studio upload defaults: language and category. Chapters written in the description override automatic ones.
2. **Set up Google Cloud.**
   - Create a project and enable the YouTube Data API v3.
   - OAuth audience: External, then **Publish app** to "In production". An app left in "Testing" gets refresh
     tokens that expire after 7 days. An unverified app in production is allowed for personal use, behind a
     click-through warning.
   - Create an OAuth client of type **Desktop app** (loopback redirect, PKCE).
   - Request one scope: `https://www.googleapis.com/auth/youtube.force-ssl`.
3. **Authorize once.** `publish.mjs --auth` stores the refresh token in the macOS Keychain.
4. **Run a smoke test.** Upload a 10-second clip as unlisted.
   - The current API reference says uploads from unverified projects are no longer restricted to private. The Help
     Center still says they get locked with no appeal. The test settles it.
   - If the clip gets locked, there are two routes. Plan B: Kaan uploads the mp4 in Studio, and
     `publish.mjs --video <id>` sets everything else through the API. Or file the API audit form.

**Per video**

1. The build writes the film, SRT, chapters, thumbnails and `youtube.json`.
2. Validate against YouTube's limits:
   - title ≤100 characters, no `<` or `>`;
   - description ≤5,000 bytes;
   - tags ≤500 characters in total;
   - chapter rules as above;
   - thumbnail JPG or PNG, 16:9.
3. Resumable `videos.insert`.
   - Upload as private with `publishAt`, or as unlisted for review.
   - Set `selfDeclaredMadeForKids: false` and `containsSyntheticMedia: false`. YouTube's policy lists "cloning one's
     own voice to create voice overs" as needing no disclosure.
4. Call `thumbnails.set`, `captions.insert` with the SRT, and `playlistItems.insert`.
5. In Studio, by hand, about a minute:
   - end screen (import it from the previous video);
   - Test & compare with the three thumbnails;
   - pin the question.

There is no API for the first two.

Quota per video is about 550 of the 10,000 shared units a day (captions alone cost 400). Uploads have their own
bucket of 100 a day.

## 9. Where this plan departs from the brief

1. **Order by the viewer's job and search demand, not by feature size.** Small features become chapters and Shorts.
   The first videos are Getting started, the core jobs, and "Leaving Evernote?".
2. **Not one video for everything.** A 10–12 min Getting started plus focused 3–7 min tutorials. The skill's current
   2–5 min target is short for a complete answer; both channels' best tutorials run 6–9 min.
3. **Two kinds of release video.** The release showreel is right for X and the landing page. On YouTube, the
   format that works is a narrated walkthrough, so do both.
4. **Don't copy Evernote's volume.** Weekly clips and monthly recaps do not pay off organically. Fewer, durable
   films with good titles and thumbnails do.
5. **YouTube will not find us first.** Nobody searches "memrynote" yet. Titles name the job, and the first viewers
   come from our own surfaces: docs, the app, emails, the landing page and X.
6. **Bring in the human another way.** Neither channel works without a person, and the voice clone cannot ad-lib.
   Use first-person opinions, Maya's story, and, if Kaan wants, a 10–20 s real intro on What's new videos.

## 10. Growth ideas

1. Lead acquisition with M1 "Leaving Evernote?". Its audience is asking where to go, and memrynote's answers are
   price, privacy, AI off by default, and an ENEX import.
2. Method videos (GTD, PARA, weekly review) draw search traffic that doesn't depend on the brand.
3. A visible privacy demo: go offline, keep working, sync, and explain the encryption in one diagram.
4. Embed the videos in the docs, the app, the release notes and the emails, with UTM links to measure installs.
5. A comment loop: a specific closing question, pinned. Answer it, make the requested video, and credit the
   request.
6. Captions plus localized titles and descriptions through the API's `localizations`. Dubbing comes later.
