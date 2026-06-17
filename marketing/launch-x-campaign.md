# memrynote — X launch campaign (Jun 18 → Jun 30)

Source of truth for the pre-launch X (Twitter) schedule. Launch day is **Jun 30 (Tue)**.

- **Account:** [@h4yfans](https://x.com/h4yfans)
- **Audience:** United States (spans ET → PT, 3-hour spread)
- **Timezone:** schedule in **America/New_York (ET)**. PT equivalent shown in parentheses on every post.
- **Status:** DRAFT until Kaan publishes. Created in Postiz as scheduled drafts.
- **Voice rules:** specific over superlative · founder first-person · one idea per tweet · soft CTA · no "🚀 introducing" / "thrilled" / "game-changer" / emoji-bullet lists / fake urgency · lowercase `memrynote` · calm, dry, a little duck.
- **Links:** site `memrynote.com` · repo `github.com/memrynote/memry`
- **IDs** (e.g. `D18-1`) are stable handles for mapping each post to its Postiz entry.

### Timing — why these slots (US data, 2026)

Peak US engagement on X is **weekday mid-morning to mid-afternoon (9 AM–3 PM)**, with **Tue/Wed/Thu strongest** and **Tue 9 AM the single best slot**. Sat/Sun and Fri are weakest. To cover both coasts, slots are picked so ET-morning ≈ PT-early-morning and ET-afternoon ≈ PT-midday.

- **4-post days (ET):** `9:00 AM · 12:00 PM · 3:00 PM · 6:00 PM`
- **5-post days (ET):** `9:00 AM · 11:00 AM · 1:00 PM · 3:00 PM · 6:00 PM`
- **Launch thread (Tue Jun 30):** `9:00 AM ET` — the peak slot. Replies +1 min each.
- Weekend/Friday posts run lower reach by design — the heaviest message (launch) sits on Tuesday on purpose. Don't move the launch thread off Jun 30 9 AM ET.

### Media strategy — every post has an attachment, but mixed

Nothing should scroll past as plain text, but they're **not all product screenshots** (that reads repetitive and ad-like). Four types:

- 🖼️ **SCREENSHOT** — real UI, for feature/proof posts
- 🎬 **GIF / VIDEO** — motion, for the hero feature moments
- 📝 **QUOTE CARD** — brand editorial card (cream paper, Fraunces serif, terracotta accent, mono label, optional duck corner) with the tweet's key line set in it. Used for philosophy posts — on-brand and eye-catching without faking a feature. Batch-make from one template; _I can draft these as HTML if you want._
- 📷 **PHOTO** — duck / desk / founder, for personal + indie posts

A few launch-thread replies stay text-only on purpose.

### Production checklist (group your shoots by type)

**🖼️ Screenshots**

- [ ] `D18-1` / `D20-1` / `D30-3` — Finder folder of your `.md` files next to the app (the "they're just files" proof)
- [ ] `D18-4` — clean hero shot of the app (home or inbox)
- [ ] `D19-1` — security / encryption panel in settings
- [ ] `D19-3` — how a synced note looks server-side (ciphertext / hex)
- [ ] `D20-2` — a memrynote note opened as `.md` in another editor (VS Code)
- [ ] `D20-3` — same note side-by-side in memrynote + another editor
- [ ] `D21-2` / `D28-4` — the GitHub repo (AGPL-3.0 / license visible)
- [ ] `D21-5` / `D29-2` — landing page / waitlist form
- [ ] `D22-2` — inbox quick-capture box
- [ ] `D22-3` — inbox with mixed items (links, notes, tasks)
- [ ] `D22-4` — capturing with the offline indicator showing
- [ ] `D23-2` — before/after: cluttered web page vs clean saved article
- [ ] `D23-3` — search hitting both notes and clipped articles
- [ ] `D23-4` — a clipped article shown as a plain `.md` file
- [ ] `D24-1` — import picker showing the 9 sources
- [ ] `D24-2` — import in progress / imported note tree
- [ ] `D24-3` — an imported Evernote/Notion note rendered cleanly
- [ ] `D24-4` — imported tasks with due dates + priorities
- [ ] `D25-2` — split view: note beside the calendar
- [ ] `D25-3` — the inline `/date` pill inside a note
- [ ] `D25-4` — journal day view with tasks + events
- [ ] `D26-1` — agent chat answering over a local vault
- [ ] `D26-2` — agent answer citing your own notes
- [ ] `D26-3` — agent panel with a local/offline badge
- [ ] `D26-4` — agent provider/model settings (local model or own key)
- [ ] `D27-1` — the app working fully offline
- [ ] `D27-2` — two devices showing the same note synced
- [ ] `D27-3` — sync settings (opt-in toggle)
- [ ] `D28-1` — collage of the 3 shipped features (or changelog)
- [ ] `D29-3` — then/now: an early build vs today
- [ ] `D30-5` — one-workspace overview (inbox/notes/tasks/journal/calendar)

**🎬 GIFs / video**

- [ ] `D22-1` — paste a link → it lands in the inbox
- [ ] `D23-1` — one click → readable article in inbox
- [ ] `D25-1` — `/date` → reminder → shows on calendar
- [ ] `D30-1` — short launch demo video (recommended)

**📝 Quote cards** (brand paper/serif template)

- [ ] `D18-2` — "the cloud is optional."
- [ ] `D18-3` — "the cloud is just someone else's computer."
- [ ] `D19-2` — "math, not a promise."
- [ ] `D19-4` — "could someone read my journal? no."
- [ ] `D20-4` — "the exit is the front door."
- [ ] `D21-3` — "i read every bug report myself."
- [ ] `D27-4` — "sync is the bonus, never the dependency."
- [ ] `D28-2` — "the 200 tiny things between 'works on my machine' and 'works on yours.'"
- [ ] `D29-1` — big "tomorrow." on paper

**📷 Photos**

- [ ] `D19-5` / `D21-4` / `D25-5` / `D29-4` — the duck
- [ ] `D21-1` — you at your desk / workspace
- [ ] `D28-3` — desk / late-night build shot _(optional)_

### Postiz execution plan (after green light)

1. Connect to Postiz on `root@178.105.205.174` (API key or DB).
2. Delete every scheduled/published post dated **after Jun 17**. (Keep ≤ Jun 17 untouched.)
3. Create all posts below as **drafts**, scheduled at the listed date/time **(ET)**, attaching the listed media where ready.
4. Launch-day posts `D30-1…6` are one **thread** (reply chain), not separate posts.

---

## Act 1 — Why (Jun 18–21)

### Thu Jun 18 — Why local-first

- **D18-1** · 9:00 AM ET _(6:00 AM PT)_
  > i wanted notes that felt like continuing a thought, not managing software. so i'm building memrynote: local-first, your notes live as plain .md files on your own disk. nothing to lock you in. launching end of june.
  - 🖼️ **SCREENSHOT:** Finder folder of your `.md` files next to the app window
- **D18-2** · 12:00 PM ET _(9:00 AM PT)_
  > local-first means the app opens instantly, works on a train with no signal, and never spins a loader waiting on someone's server. your stuff is already on your machine. the cloud is optional.
  - 📝 **QUOTE CARD:** "the cloud is optional."
- **D18-3** · 3:00 PM ET _(12:00 PM PT)_
  > "the cloud" is just someone else's computer holding your private thoughts. memrynote flips it: your computer holds them, encrypted, and syncs only when you ask it to.
  - 📝 **QUOTE CARD:** "the cloud is just someone else's computer."
- **D18-4** · 6:00 PM ET _(3:00 PM PT)_
  > 13 days out. i'll post a little every day until launch — the why, the how, and the parts i'm proud of. follow along if a calm, private workspace sounds like your thing.
  - 🖼️ **SCREENSHOT:** clean hero shot of the app (home or inbox)

### Fri Jun 19 — Privacy / encryption

- **D19-1** · 9:00 AM ET _(6:00 AM PT)_
  > most note apps quietly ask you to trust a server with your unencrypted thoughts. memrynote is end-to-end encrypted, and i never hold your keys. i can't read your journal. neither can a breach.
  - 🖼️ **SCREENSHOT:** security / encryption panel in settings
- **D19-2** · 11:00 AM ET _(8:00 AM PT)_
  > "we take your privacy seriously" is what companies say after the leak. memrynote's answer is math, not a promise: encrypted on your device before anything is ever synced.
  - 📝 **QUOTE CARD:** "math, not a promise."
- **D19-3** · 1:00 PM ET _(10:00 AM PT)_
  > zero-knowledge isn't a marketing word here. the sync server stores your notes as ciphertext it literally cannot open. that's the whole design, not a setting you toggle.
  - 🖼️ **SCREENSHOT:** how a synced note looks server-side (ciphertext / hex)
- **D19-4** · 3:00 PM ET _(12:00 PM PT)_
  > ask any note app one question: if it got breached tomorrow, could someone read my journal? for memrynote the answer is no. that felt non-negotiable to build.
  - 📝 **QUOTE CARD:** "could someone read my journal? no."
- **D19-5** · 6:00 PM ET _(3:00 PM PT)_
  > your second brain holds more about you than your phone does. it should be at least as private. 🦆
  - 📷 **PHOTO:** the duck

### Sat Jun 20 — Own your data / no lock-in

- **D20-1** · 9:00 AM ET _(6:00 AM PT)_
  > "own your data" is on every landing page. here's what it means in memrynote: open the folder → see your notes as .md → copy them anywhere → delete the app → keep everything. no export button required.
  - 🖼️ **SCREENSHOT:** Finder folder of your `.md` files
- **D20-2** · 12:00 PM ET _(9:00 AM PT)_
  > plain markdown files. no proprietary format, no database you can't read, no "request your data" form that emails you a zip in 30 days. it's just files. they're yours today.
  - 🖼️ **SCREENSHOT:** a memrynote note opened as `.md` in VS Code
- **D20-3** · 3:00 PM ET _(12:00 PM PT)_
  > lock-in is a feature for them and a trap for you. memrynote has no walls: your notes open in any markdown editor, your folder syncs with whatever you already use. leave anytime — i'd rather earn it.
  - 🖼️ **SCREENSHOT:** same note side-by-side in memrynote + another editor
- **D20-4** · 6:00 PM ET _(3:00 PM PT)_
  > i've migrated between note apps enough times to resent every one that made it hard. so memrynote's exit is the front door: it's already your files, in a folder you chose.
  - 📝 **QUOTE CARD:** "the exit is the front door."

### Sun Jun 21 — Indie / solo dev

- **D21-1** · 9:00 AM ET _(6:00 AM PT)_
  > no investors. no growth team telling me to paywall your own notes. just me, building the workspace i wished existed — with care, not a race to monetize your data.
  - 📷 **PHOTO:** you at your desk / workspace
- **D21-2** · 11:00 AM ET _(8:00 AM PT)_
  > memrynote is open source, AGPL-3.0. every line is yours to read. a notes app that wants your private thoughts owes you that much. github.com/memrynote/memry
  - 🖼️ **SCREENSHOT:** the GitHub repo (AGPL-3.0 / license visible)
- **D21-3** · 1:00 PM ET _(10:00 AM PT)_
  > being solo means no committee waters down the opinionated parts. it also means i read every bug report myself. trade-offs i'll happily take.
  - 📝 **QUOTE CARD:** "i read every bug report myself."
- **D21-4** · 3:00 PM ET _(12:00 PM PT)_
  > the duck on my shoulder has reviewed more of this codebase than any VC. she approves. 🦆 (9 days to launch)
  - 📷 **PHOTO:** the duck
- **D21-5** · 6:00 PM ET _(3:00 PM PT)_
  > if you've ever wanted to back a small, independent tool instead of feeding another data machine — this is one of those. waitlist's open: memrynote.com
  - 🖼️ **SCREENSHOT:** landing page / waitlist form

---

## Act 2 — What (Jun 22–27)

### Mon Jun 22 — Inbox / capture

- **D22-1** · 9:00 AM ET _(6:00 AM PT)_
  > the inbox is the part i use most. paste a link, jot a thought, drop a task — it all lands in one encrypted place. capture now, sort when you're not rushed.
  - 🎬 **GIF:** paste a link → it lands in the inbox
- **D22-2** · 12:00 PM ET _(9:00 AM PT)_
  > the worst time to organize is the moment you have an idea. memrynote's inbox lets you catch it in one keystroke and decide where it lives later. friction kills thoughts.
  - 🖼️ **SCREENSHOT:** inbox quick-capture box
- **D22-3** · 3:00 PM ET _(12:00 PM PT)_
  > everything starts in the inbox: links, notes, tasks, half-sentences. then you file it into a note, turn it into a task, or let it go. one funnel, zero lost ideas.
  - 🖼️ **SCREENSHOT:** inbox with mixed items (links, notes, tasks)
- **D22-4** · 6:00 PM ET _(3:00 PM PT)_
  > small thing i love: capture works the same whether you're online or on a plane. the inbox never waits for a server to say yes.
  - 🖼️ **SCREENSHOT:** capturing with the offline indicator showing

### Tue Jun 23 — Web clipper / link capture

- **D23-1** · 9:00 AM ET _(6:00 AM PT)_
  > see something worth keeping while browsing? one click, and the readable article — not the ad soup — lands in your memrynote inbox. offline, encrypted, searchable. yours.
  - 🎬 **GIF:** one click → readable article in inbox
- **D23-2** · 12:00 PM ET _(9:00 AM PT)_
  > the web clipper strips a page down to the actual words. no cookie banners, no newsletter popups, no "related stories." just the thing you wanted to read, saved clean.
  - 🖼️ **SCREENSHOT:** before/after — cluttered page vs clean saved article
- **D23-3** · 3:00 PM ET _(12:00 PM PT)_
  > i save a lot of articles "to read later." later never came until they were mine, offline, and searchable in the same place as my notes. so i built that.
  - 🖼️ **SCREENSHOT:** search hitting both notes and clipped articles
- **D23-4** · 6:00 PM ET _(3:00 PM PT)_
  > your read-it-later pile shouldn't live on a startup that might shut down next year. clip it into memrynote and it's a plain note on your disk. files outlast apps.
  - 🖼️ **SCREENSHOT:** a clipped article shown as a plain `.md` file

### Wed Jun 24 — Importers / switching

- **D24-1** · 9:00 AM ET _(6:00 AM PT)_
  > switching note apps is the hard part, so i made it boring. memrynote imports from Notion, Obsidian, Apple Notes, Evernote, Bear, Roam, Google Keep, Todoist & TickTick. bring everything. lose nothing.
  - 🖼️ **SCREENSHOT:** import picker showing the 9 sources
- **D24-2** · 12:00 PM ET _(9:00 AM PT)_
  > you shouldn't have to abandon ten years of notes to try something new. point memrynote at your old export and it rebuilds your notes, attachments and structure as markdown.
  - 🖼️ **SCREENSHOT:** import in progress / imported note tree
- **D24-3** · 3:00 PM ET _(12:00 PM PT)_
  > i tested the importers against real, messy exports — Evernote's weird HTML, Apple Notes' protected database, Notion's zip maze. the ugly edge cases are where switching usually dies. those are handled.
  - 🖼️ **SCREENSHOT:** an imported Evernote/Notion note rendered cleanly
- **D24-4** · 6:00 PM ET _(3:00 PM PT)_
  > tasks too: bring your Todoist projects or TickTick backup and they land as real tasks with due dates and priorities, not flat text. moving in shouldn't cost you structure.
  - 🖼️ **SCREENSHOT:** imported tasks with due dates + priorities

### Thu Jun 25 — One workspace

- **D25-1** · 9:00 AM ET _(6:00 AM PT)_
  > inbox, notes, tasks, journal and calendar aren't four apps pretending to talk to each other in memrynote. type today's date in a note and it quietly becomes a reminder on the right device. it's one place.
  - 🎬 **GIF:** `/date` → reminder → shows on calendar
- **D25-2** · 11:00 AM ET _(8:00 AM PT)_
  > i was tired of a notes app, a separate to-do app, a journal app, and a calendar that knew about none of them. in memrynote a thought can become a task, a task can have a date, and that date shows on your calendar.
  - 🖼️ **SCREENSHOT:** split view — note beside the calendar
- **D25-3** · 1:00 PM ET _(10:00 AM PT)_
  > type /date in any note for an inline pill. give it a time and it becomes a reminder — derived per device, so it nudges you on the machine you're actually at.
  - 🖼️ **SCREENSHOT:** the inline `/date` pill inside a note
- **D25-4** · 3:00 PM ET _(12:00 PM PT)_
  > journaling lives in the same app as everything else. today's note, today's tasks, today's events — one page, not a tab-switching ritual.
  - 🖼️ **SCREENSHOT:** journal day view with tasks + events
- **D25-5** · 6:00 PM ET _(3:00 PM PT)_
  > fewer apps, fewer logins, fewer places for a thought to fall through. that's the whole pitch. 🦆
  - 📷 **PHOTO:** the duck

### Fri Jun 26 — Local AI / agent

- **D26-1** · 9:00 AM ET _(6:00 AM PT)_
  > your notes never leave your machine — so the AI that reads them shouldn't either. memrynote's assistant works against your local vault. your second brain isn't going into anyone's training set.
  - 🖼️ **SCREENSHOT:** agent chat answering over a local vault
- **D26-2** · 12:00 PM ET _(9:00 AM PT)_
  > ask it to find, summarize or connect things across your own notes — running locally, over files only you can decrypt. an assistant that doesn't phone home with your private writing.
  - 🖼️ **SCREENSHOT:** agent answer citing your own notes
- **D26-3** · 3:00 PM ET _(12:00 PM PT)_
  > most "AI notes" features are a polite way to upload your journal to a server. memrynote's agent reads a local vault through a local server. same convenience, none of the leak.
  - 🖼️ **SCREENSHOT:** agent panel with a local / offline badge
- **D26-4** · 6:00 PM ET _(3:00 PM PT)_
  > point it at a local model or your own key — either way the architecture is the same: your notes stay encrypted and on your disk. the AI comes to them.
  - 🖼️ **SCREENSHOT:** agent provider / model settings

### Sat Jun 27 — Offline-first + sync

- **D27-1** · 9:00 AM ET _(6:00 AM PT)_
  > airplane mode is just normal mode. memrynote is offline-first: a local sqlite + .md vault. sync is the bonus, never the dependency. it works on a train with no signal.
  - 🖼️ **SCREENSHOT:** the app working fully offline
- **D27-2** · 12:00 PM ET _(9:00 AM PT)_
  > when you do sync, it's end-to-end encrypted across your devices — and conflict-free, so editing the same note on your laptop and phone just merges. no "which version do you want" dialog.
  - 🖼️ **SCREENSHOT:** two devices showing the same note synced
- **D27-3** · 3:00 PM ET _(12:00 PM PT)_
  > sync is opt-in. don't want a server in the loop at all? keep it fully local and sync the folder yourself. your call, not mine.
  - 🖼️ **SCREENSHOT:** sync settings (opt-in toggle)
- **D27-4** · 6:00 PM ET _(3:00 PM PT)_
  > i built sync last, on purpose. the app had to be complete and useful with zero internet first. anything else is a cloud app wearing a local-first costume.
  - 📝 **QUOTE CARD:** "sync is the bonus, never the dependency."

---

## Act 3 — Build-in-public + countdown (Jun 28–29)

### Sun Jun 28 — Build-in-public

- **D28-1** · 9:00 AM ET _(6:00 AM PT)_
  > shipped this stretch toward launch: browser link-capture, importers for 9 apps, encrypted device pairing for sync. the boring infrastructure is the part you'll never notice. that's the point.
  - 🖼️ **SCREENSHOT:** collage of the 3 shipped features (or changelog)
- **D28-2** · 12:00 PM ET _(9:00 AM PT)_
  > two days out. the to-do list now is the unglamorous stuff: polish, edge cases, the 200 tiny things between "works on my machine" and "works on yours."
  - 📝 **QUOTE CARD:** "the 200 tiny things between 'works on my machine' and 'works on yours.'"
- **D28-3** · 3:00 PM ET _(12:00 PM PT)_
  > building in public means you see the seams too. it's a 1.0 from one person. it'll have rough edges, and i'll fix them in the open. i'd rather ship honest than ship perfect-looking.
  - 📷 **PHOTO:** desk / late-night build shot _(optional)_
- **D28-4** · 6:00 PM ET _(3:00 PM PT)_
  > open source, AGPL-3.0. want to read exactly how the encryption and sync work before trusting them with your notes? you can. github.com/memrynote/memry
  - 🖼️ **SCREENSHOT:** GitHub repo, encryption / sync code visible

### Mon Jun 29 — Countdown

- **D29-1** · 9:00 AM ET _(6:00 AM PT)_
  > tomorrow. memrynote launches — a local-first, end-to-end encrypted home for your inbox, notes, tasks and journal.
  - 📝 **QUOTE CARD:** big "tomorrow." on paper
- **D29-2** · 12:00 PM ET _(9:00 AM PT)_
  > if a calm, private, indie workspace sounds like your kind of thing, the waitlist is open and you'll be first in. memrynote.com
  - 🖼️ **SCREENSHOT:** waitlist / landing page
- **D29-3** · 3:00 PM ET _(12:00 PM PT)_
  > a year ago this was a folder of .md files and a stubborn opinion about who should own your notes. tomorrow it's an app. wild.
  - 🖼️ **SCREENSHOT:** then/now — an early build vs today
- **D29-4** · 6:00 PM ET _(3:00 PM PT)_
  > last duck check before launch: she's perched, she's judgmental, she's ready. 🦆 see you tomorrow.
  - 📷 **PHOTO:** the duck

---

## Launch — Tue Jun 30 (thread)

> Post `D30-1…6` as a single thread (reply chain). Pin `D30-1`. 9 AM ET Tuesday = the peak US slot.

- **D30-1** · 9:00 AM ET _(6:00 AM PT)_
  > memrynote is live. a local-first, end-to-end encrypted workspace for your inbox, notes, tasks & journal. here's what it is, and why i built it 🧵
  - 🎬 **VIDEO:** short launch demo (recommended) — or hero screenshot
- **D30-2** · 9:01 AM ET (reply)
  > the problem: i loved my old notes app until i realized i was renting my own thoughts. cloud lock-in, unencrypted servers, a plugin maze, and a roadmap aimed at my wallet, not my work.
  - _(text-only — keeps the thread human)_
- **D30-3** · 9:02 AM ET (reply)
  > so memrynote keeps your data where it belongs — on your machine, as plain .md files. open the folder anytime. no export, no lock-in. delete the app and your notes are still sitting right there.
  - 🖼️ **SCREENSHOT:** folder of `.md` files (the "your data" proof)
- **D30-4** · 9:03 AM ET (reply)
  > private by design. end-to-end encrypted with keys only you hold. i can't read your journal — that's not a policy, it's the architecture.
  - _(text-only)_
- **D30-5** · 9:04 AM ET (reply)
  > one workspace, not four: inbox to capture, notes to think, tasks to do, journal + calendar to remember. plus a browser clipper, AI that runs on your local vault, and importers for 9 apps you might be leaving.
  - 🖼️ **SCREENSHOT:** one-workspace overview (inbox/notes/tasks/journal/calendar)
- **D30-6** · 9:05 AM ET (reply)
  > open source, AGPL-3.0, built by one person — me — with care, not a VC clock. download it, kick the tires, tell me what's broken. thank you for being here early. — Kaan. memrynote.com
  - _(text-only — the sign-off)_
