# Launch kit: Show HN and Product Hunt

Issue #3471. Drafts for both launches. Nothing has been posted.

Launch after the onboarding experiment (#3458) has raised activation. A launch brings one spike of
new installs, and with today's activation most of it would leave in the first week.

Every claim below matches the README, `marketing/growth/alternativeto.md` and the security white
paper (`apps/docs/src/architecture/security-white-paper.md`) as of 2026-11-18. Check pricing,
platforms and the "limits" list again on launch day.

## Links

Tag every `memrynote.com` link as `marketing/utm.md` says, so the growth page shows each launch as
its own source:

- Show HN: `https://memrynote.com/?utm_source=hackernews&utm_medium=referral&utm_campaign=launch`
- Product Hunt: `https://memrynote.com/?utm_source=producthunt&utm_medium=referral&utm_campaign=launch`

The Show HN post itself links to the GitHub repo, which needs no tag.

## Show HN

### Title

HN allows 80 characters. Use the product name and what it is, with no adjectives.

> Show HN: Memrynote, notes, tasks and a journal in Markdown files with E2EE sync

Fallback if the first reads as a list:

> Show HN: Memrynote, an open-source local-first notes app with encrypted sync

URL: `https://github.com/memrynote/memry`. HN readers trust a repo link more than a landing page,
and the README has the download links.

### First comment

Post it right after submitting. It is Kaan's voice, first person.

> Hi HN, I'm Kaan. I built memrynote because I was switching between four apps to get through a
> day (notes, tasks, a journal, a calendar), and with ADHD the switching wore me out before I had
> started. I wanted one app for all of it that kept my data on my own disk.
>
> What it is: a desktop app for Mac, Windows and Linux. Your vault is a folder of Markdown files
> with YAML frontmatter, so any editor can open it, and the app works offline with no account.
> Tasks and projects live in a SQLite file inside the vault. There is a journal with one page per
> day, a calendar, an inbox for links and files, and a canvas. An optional AI agent works on the
> vault through a local MCP server. It runs with Claude Code, Codex or a local OpenAI-compatible
> model, and you approve each write it makes.
>
> Architecture: the desktop app is Electron and TypeScript. Note and journal bodies are Yjs CRDTs,
> so edits from two offline devices merge. Tasks merge per field with vector clocks. Sync is
> end-to-end encrypted. Each change is encrypted on the device with XChaCha20-Poly1305 and signed
> with Ed25519. The master key comes from a 24-word recovery phrase through Argon2id. The sync
> server runs on Cloudflare Workers and stores ciphertext in R2 and routing metadata in D1. The
> iOS app (TestFlight beta) is SwiftUI over a shared Rust core, and the two implementations agree
> through a written protocol spec and test vectors.
>
> Open source: everything is AGPL-3.0 in this repo: the desktop app, the iOS app, the Rust core,
> the sync server, the CLI and the web clipper.
>
> Business model: every feature is free. Sync between devices is the only paid part, from $5 a
> month. That pays for the servers.
>
> Limits, so you don't have to find them:
>
> - It's a beta. Back up your vault.
> - No independent security audit yet. The protocol is specified in `docs/protocol/`, and the
>   white paper lists what the server can see.
> - The server can read tag names, folder paths and journal dates, because they form item ids.
>   It cannot read note titles or bodies.
> - No self-hosted sync server yet. It is on the roadmap.
> - No Android app and no web app.
> - The vault on disk is plain files. Its protection is your OS disk encryption.
> - Anonymous usage metrics are on by default. Settings > General > Privacy turns them off.
>
> I'd like to hear what breaks for you, and what would make you switch or not.

### Prepared answers

Answer in your own words. These are the facts to draw on.

**Why Electron?** One TypeScript codebase ships the same app to macOS, Windows and Linux, and the
editor is built on web tech (BlockNote, on ProseMirror). A solo developer could not keep three
native desktop apps in step. The cost is memory and download size, and that is a fair complaint.
Where a native app mattered more, on iPhone, the app is SwiftUI over a Rust core.

**How does the encryption work?** Each change is encrypted on the device with
XChaCha20-Poly1305 before upload and signed with Ed25519, so a device can tell which device wrote
it. The master key is derived from the 24-word recovery phrase with Argon2id. It reaches the
server only encrypted, when you link a new device. The server holds no keys. It stores ciphertext
plus the metadata it needs to route it. Tag names, folder paths and journal dates are readable
because they form item ids. Crypto is libsodium. The white paper is at
`https://docs.memrynote.com/architecture/security-white-paper`, and the wire format is in
`docs/protocol/`. No audit has been done.

**What's the business model? Will it stay free?** The app is free, with every feature, and needs
no account. Sync is paid: Plus $5 a month (1 GB, 1 vault), Pro $10 a month (10 GB, 10 vaults),
Believer $500 once (50 GB, unlimited vaults). No feature sits behind a plan. If memrynote stopped,
your vault is still a folder of Markdown files, and the code is AGPL.

**Can I self-host sync?** Not yet. The sync server code is in the repo under AGPL-3.0, but it is
built for Cloudflare Workers, D1 and R2, and there is no supported self-host setup or docs. A
self-hosted server is on the roadmap. Until then the app works fully without sync.

**How is this different from Obsidian?** The vault is the same idea, a folder of Markdown files.
memrynote builds in tasks with kanban views, a calendar, a journal and an inbox instead of
plugins, and its sync is end-to-end encrypted and open source. Obsidian has a far larger plugin
ecosystem, an Android app and years more polish.

**Does the AI agent send my notes anywhere?** Only to the model provider you pick. The agent
reaches the vault through an MCP server on `localhost`. With a local OpenAI-compatible model,
nothing leaves the machine. AI is off until you turn it on.

**What do the usage metrics collect?** Anonymous product events (for example, that a note was
updated), no content. They are on by default and Settings > General > Privacy turns them off.
Answer this one directly. HN will ask.

**Why AGPL?** AGPL requires anyone who runs a modified sync server for others to publish their
changes. Give your own reason for choosing it.

### On the day

- Post on a weekday between 8 and 10 am US Eastern.
- Do not ask anyone to upvote. HN penalizes voting rings, and links straight to the post count as
  one.
- Stay on the thread for the first 6 hours. Answer every top-level comment, including the hostile
  ones, with facts.
- Fix small bugs people report the same day if you can, and say so in the thread.

## Product Hunt

### Listing

| Field         | Value                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| Name          | memrynote                                                                               |
| Tagline       | Notes, tasks and a journal in Markdown files on your disk (57 of 60 characters)         |
| Website       | `https://memrynote.com/?utm_source=producthunt&utm_medium=referral&utm_campaign=launch` |
| Topics        | Productivity, Note and Writing, Privacy, Open Source                                    |
| Pricing       | Free, with paid sync                                                                    |
| Thumbnail     | `apps/desktop/build/icon.png`, 240 x 240 export                                         |
| First comment | The maker comment below                                                                 |

Description (under 260 characters):

> An open-source desktop app for notes, tasks, a daily journal and a calendar. Your vault is a
> folder of Markdown files, it works offline with no account, and sync between devices is
> end-to-end encrypted. Free on Mac, Windows and Linux.

### Gallery

Product Hunt shows images at 1270 x 760. Capture each in the light theme from a demo vault with
no personal data. The first image is the one people see in the feed.

| Order | Image                                                                                  | Landing reference     |
| ----- | -------------------------------------------------------------------------------------- | --------------------- |
| 1     | A note with tags, tasks and wiki links next to the day's calendar, with the tagline    | `hero_white.webp`     |
| 2     | Tasks grouped by due date, one task's subtasks open                                    | `task_white.webp`     |
| 3     | A journal day next to the month calendar                                               | `journal_white.webp`  |
| 4     | The vault folder open in Finder next to the app, showing the same note as a `.md` file | none, capture new     |
| 5     | The calendar week view                                                                 | `calendar_white.webp` |
| 6     | The AI agent editing a note, with the approval prompt visible                          | `note_white.webp`     |
| 7     | A canvas with note cards                                                               | `canvas_white.webp`   |
| 8     | A diagram: device encrypts, server stores ciphertext, other device decrypts            | none, draw new        |

A 30 to 60 second video can go first instead of image 1. `marketing/explainer-30s/` is a start.

### Maker comment

> Hi Product Hunt, I'm Kaan, the solo developer behind memrynote.
>
> I have ADHD, and for years I bounced between a notes app, a task app, a journal and a calendar.
> The switching cost me more than the work. I built memrynote to put all four in one calm place,
> without renting my own notes back from a server I don't control.
>
> - Your vault is a folder of Markdown files on your disk. Any editor opens it.
> - It works offline and needs no account.
> - Sync between devices is end-to-end encrypted. The server stores ciphertext.
> - The whole thing is open source under AGPL-3.0.
> - Every feature is free. Sync is the only paid part.
>
> It imports from Notion, Evernote, OneNote, Obsidian, Apple Notes, Bear, Todoist and more, so you
> can try it on your real notes.
>
> It's a beta, and I read every comment. Tell me what you'd need to switch.

### Before launch day

- Kaan creates the Product Hunt maker account at least a week ahead and uses it (comments,
  upvotes on other launches), since brand-new accounts carry less weight.
- Pick a Tuesday, Wednesday or Thursday. Product Hunt days start at 12:01 am Pacific.
- Schedule the launch in Product Hunt's scheduler with the listing above.
- Prepare the gallery images at 1270 x 760.
- Check that `memrynote.com/download` serves the current release on all three platforms.
- Make sure the signup and sync checkout work on production.

### Launch day

- At 12:01 am Pacific, check the post is live, then add the maker comment.
- Share the post link on X, Reddit (r/memrynote) and the waitlist with "we launched today".
  Product Hunt forbids asking for upvotes, so don't.
- Reply to every comment the same day.
- Note crashes and bug reports in GitHub issues as they come in.

### After

- On the next weekly growth report, read the `producthunt` and `hackernews` rows in the channel
  section, and the activation of that week's cohort.
- Record in a comment on #3471 how many installs the spike brought and how many were still active
  after 4 weeks.
