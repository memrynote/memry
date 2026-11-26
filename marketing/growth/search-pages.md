# Target search queries and the pages meant to rank for them

Issue #3469. Each target query gets one page, so two memrynote pages never compete for the same
query. This file is the proposal for Kaan. No page has changed yet. Pages get written after Kaan
approves the list, following `apps/landing/AGENTS.md`.

## Data

Checked on 2026-11-17 through treg, for a total of $0.051:

- US monthly volume and difficulty (0 to 100) from Serpstat (`serpstat.google.keywords.volume`,
  `g_us`). Serpstat returned no row for 22 of the 49 queries. SE Ranking
  (`seranking.google.keywords.volume`, `us`) filled 3 of the 14 sent to it, marked "SER" below.
  "None" means neither database has the query.
- memrynote's Google position from the top 20 US results (`crawl4ai.google.serp.organic`, `num=20`).
  "-" means memrynote is not in the top 20.

Of the 17 queries checked on Google, memrynote.com is in the top 20 for one:
`/notesnook-alternative` is number 18 for "notesnook alternative". No Google AI overview in these
results cited memrynote.

## Map

Singular "X alternative" queries go to the comparison page for X. Plural and "best" queries are
roundup searches, and Google answers them with lists (Zapier, Reddit, XDA), so they go to a blog
roundup.

| Query                          | US/mo    | Difficulty | Position | Page meant to rank                                    | Proposal        |
| ------------------------------ | -------- | ---------- | -------- | ----------------------------------------------------- | --------------- |
| best journaling app            | 2,400    | 36         | -        | none                                                  | Add (A1)        |
| notion alternatives            | 1,600    | 13         | -        | `/blog/private-notion-alternatives-that-work-offline` | Strengthen (S2) |
| journaling app                 | 1,300    | 2          | -        | `/features/journal`                                   | Strengthen (S4) |
| journal app                    | 1,300    | 37         | -        | `/features/journal`                                   | Strengthen (S4) |
| open source note taking app    | 880      | 12         | -        | none                                                  | Add (A2)        |
| evernote alternative           | 880      | 18         | -        | `/evernote-alternative`                               | Strengthen (S1) |
| evernote alternatives          | 880      | 16         | not run  | `/evernote-alternative`                               | Strengthen (S1) |
| notion alternative             | 720      | 13         | not run  | `/notion-alternative`                                 | Strengthen (S2) |
| onenote alternatives           | 590      | 10         | not run  | `/onenote-alternative`                                | Strengthen (S3) |
| onenote alternative            | 480      | 11         | -        | `/onenote-alternative`                                | Strengthen (S3) |
| private journal app            | 320      | 55         | -        | `/blog/most-private-journaling-apps`                  | Strengthen (S5) |
| secure note taking app         | 260      | 19         | -        | none                                                  | Add (A3)        |
| open source notion alternative | 170      | 5          | not run  | `/blog/private-notion-alternatives-that-work-offline` | Strengthen (S2) |
| encrypted notes app            | 170      | 18         | -        | none                                                  | Add (A3)        |
| markdown notes app             | 170      | 15         | not run  | `/features/notes`                                     | Strengthen (S6) |
| secure notes app               | 140      | 15         | not run  | none                                                  | Add (A3)        |
| private notes app              | 110      | 12         | not run  | none                                                  | Add (A3)        |
| apple notes alternative        | 90       | 2          | not run  | `/apple-notes-alternative`                            | Keep            |
| bear alternative               | 70       | 2          | not run  | `/bear-alternative`                                   | Keep            |
| offline note taking app        | 50       | 16         | not run  | `/blog/local-first-vs-cloud-first-note-taking-apps`   | Keep            |
| open source journal app        | 40       | 39         | not run  | `/blog/most-private-journaling-apps`                  | Strengthen (S5) |
| day one alternative            | 30       | 1          | not run  | `/day-one-alternative`                                | Keep            |
| end to end encrypted notes app | 30       | 11         | -        | `/blog/best-end-to-end-encrypted-notes-apps`          | Keep            |
| encrypted journal app          | 20       | 32         | -        | `/blog/most-private-journaling-apps`                  | Strengthen (S5) |
| standard notes alternative     | 20 (SER) | 9          | -        | `/standard-notes-alternative`                         | Keep            |
| obsidian alternative           | 10 (SER) | 14         | -        | `/obsidian-alternative`                               | Keep            |
| notion alternative offline     | 10 (SER) | 17         | -        | `/blog/private-notion-alternatives-that-work-offline` | Strengthen (S2) |
| notesnook alternative          | none     |            | 18       | `/notesnook-alternative`                              | Keep            |
| local first notes app          | none     |            | -        | `/blog/local-first-vs-cloud-first-note-taking-apps`   | Keep            |

Queries with no volume in either database: "obsidian alternatives", "logseq alternative",
"joplin alternative", "capacities alternative", "anytype alternative", "local first note taking
app", "encrypted journaling app", "obsidian sync alternative", "notes app with calendar" and "note
taking app with tasks". Their existing pages stay as they are. The Obsidian figure looks low for a
query Reddit and XDA write roundups for, so treat "None" and "10" as "too small to measure", not
as zero.

The generic queries are out of scope for now: "note taking app" (22,200, difficulty 90) and "best
note taking app" (8,100). Serpstat rates the second at difficulty 5, but its results are the same
large review sites.

## Pages to add

- **A1. "best journaling app" (2,400).** A blog roundup, "The best journaling apps in 2026", with
  Day One, Apple Journal, Journey, Diarium, Obsidian daily notes and memrynote. It names what each
  does better than memrynote, for example Day One's mature iPhone app and Apple Journal's
  suggestions. It links to `/features/journal` and `/blog/most-private-journaling-apps`.
- **A2. "open source note taking app" (880, difficulty 12).** A blog roundup of open source note
  apps: Joplin, Logseq, Standard Notes, Notesnook, Trilium, SiYuan and memrynote, with license,
  platforms, encryption and sync cost for each. joplinapp.org holds the first result, and the rest
  are lists and forum threads. memrynote is AGPL-3.0 with a public repo, so it qualifies.
- **A3. "secure note taking app" (260), "encrypted notes app" (170), "secure notes app" (140) and
  "private notes app" (110).** One product page, for example `/encrypted-notes-app`, about the
  encryption a user gets: what the server sees, what it can't, and what happens without the
  password. standardnotes.com holds the first result for three of these. The `/security` page
  stays the technical reference that the white paper (#3465) links to. The other option is to
  retitle `/security` for these queries instead of adding a page.

## Pages to strengthen

- **S1. `/evernote-alternative`, "evernote alternative" and "evernote alternatives" (1,760
  together).** Add where Evernote is still better (its mature web clipper, search inside images
  and PDFs, a web app), a short import walkthrough that links
  `/blog/migrating-from-evernote-notion-to-markdown`, and an FAQ.
- **S2. Notion, 2,490 together.** `/notion-alternative` owns "notion alternative" (720). The
  roundup `/blog/private-notion-alternatives-that-work-offline` owns "notion alternatives"
  (1,600) and "open source notion alternative" (170): retitle it to start with "Notion
  alternatives" and add a license column. Each page links to the other.
- **S3. `/onenote-alternative`, "onenote alternative" and "onenote alternatives" (1,070).** The
  page says memrynote has no OneNote importer (`importer: null` in
  `apps/landing/src/lib/alternatives.ts`), but desktop ships one through Microsoft Graph
  (`apps/docs/src/user-guide/import.md`). Fix the claim and lead with the import. The NotePlan page
  has the same stale `importer: null`.
- **S4. `/features/journal`, "journaling app" and "journal app" (2,600).** The title, "Daily
  Journal & Markdown Diary, Private by Default", has neither query. Put "journaling app" in the
  title and H1. App stores and Day One fill the top results, so expect this one to move last.
- **S5. `/blog/most-private-journaling-apps`, "private journal app" (320).** It already fits. Add
  the query to the title and link it from A1.
- **S6. `/features/notes`, "markdown notes app" (170).** Put "Markdown notes app" in the title.

Every "X alternative" page also needs a section on where memrynote falls short against X, as
`/blog/best-end-to-end-encrypted-notes-apps` already has. Today the comparison pages list only
memrynote's advantages.

## Order

By volume and difficulty: S2, S1, A1, A2, S3, A3, S4, then S5 and S6. Kaan approves the list
first, because landing deploys on every merge to `main`.
