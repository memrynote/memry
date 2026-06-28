import type { PAGE_META } from './seo'

export type AltCell = boolean | 'partial'

export type AltRow = {
  feature: string
  memry: AltCell
  competitor: AltCell
}

export type AltSection = {
  heading: string
  // Answer-first paragraph (~60-100 words): leads with the direct answer for AI-search citation.
  body: string
}

export type AlternativeConfig = {
  pageKey: keyof typeof PAGE_META
  competitor: string
  eyebrow: string
  heading: string
  headingAccent: string
  // Self-contained, declarative paragraph (~120-150 words) sized for AI-search citation.
  intro: string
  // Answer-first H2 deep-dives — the bulk of the page's word count and AI-citation surface.
  sections: readonly AltSection[]
  rows: readonly AltRow[]
  pricing: { memry: string; competitor: string }
  reasons: readonly { title: string; body: string }[]
  // Honest "when the competitor is the better pick" paragraph — builds trust, lifts conversion.
  whenCompetitorWins: string
  // One-click migration via an in-app importer; null when memrynote opens the files directly.
  migration: { importer: string | null; steps: readonly string[] }
  faqs: readonly { question: string; answer: string }[]
  footnote: string
}

const COMPARISON_FOOTNOTE =
  'Comparison reflects each app’s native, out-of-the-box features as of mid-2026. Competitors may cover some rows through paid add-ons or third-party plugins.'

export const ALTERNATIVES: readonly AlternativeConfig[] = [
  {
    pageKey: 'obsidianAlternative',
    competitor: 'Obsidian',
    eyebrow: 'Obsidian alternative',
    heading: 'The Obsidian alternative with',
    headingAccent: 'tasks, calendar & encryption built in.',
    intro:
      'memrynote is a local-first alternative to Obsidian that ships notes, tasks, a calendar, and a daily journal in one app — no plugins required. Like Obsidian, it stores every note as a plain Markdown file in a folder you own, with wiki-links and backlinks connecting your thoughts. Unlike Obsidian, task management, a calendar, and an inbox are built in rather than assembled from community plugins, and end-to-end encrypted sync is part of the product instead of a separate paid add-on. memrynote runs on macOS, Windows, and Linux, is open source, and works fully offline without an account.',
    rows: [
      { feature: 'Local Markdown files you own', memry: true, competitor: true },
      { feature: 'Wiki-links & backlinks', memry: true, competitor: true },
      { feature: 'Built-in task management', memry: true, competitor: 'partial' },
      { feature: 'Built-in calendar', memry: true, competitor: false },
      { feature: 'Daily journal', memry: true, competitor: 'partial' },
      { feature: 'Inbox / quick capture', memry: true, competitor: 'partial' },
      { feature: 'End-to-end encrypted sync included', memry: true, competitor: 'partial' },
      { feature: 'Works without plugins', memry: true, competitor: false },
      { feature: 'Open source', memry: true, competitor: false }
    ],
    reasons: [
      {
        title: 'No plugin tax',
        body: 'Tasks, calendar, inbox, and journal are first-class features — not community plugins you maintain and debug yourself.'
      },
      {
        title: 'One app, not ten',
        body: 'Stop stitching together separate plugins for what should be a single connected workspace.'
      },
      {
        title: 'Encryption included',
        body: 'End-to-end encrypted sync is part of the product, not a separate paid subscription bolted on top.'
      },
      {
        title: 'Open & cross-platform',
        body: 'Open source, on macOS, Windows, and Linux, with your notes as portable Markdown you can read anywhere.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good Obsidian alternative?',
        body: 'Yes. memrynote is a local-first Obsidian alternative that keeps every note as a plain Markdown file in a folder you own, with the same wiki-links and backlinks. The difference is scope: tasks, a calendar, a daily journal, and an inbox are built in as first-class features, so you are not assembling and maintaining community plugins to get a complete workspace. It runs on macOS, Windows, and Linux, works fully offline, and needs no account.'
      },
      {
        heading: 'Your notes stay as local Markdown files',
        body: 'Like Obsidian, memrynote stores notes as portable .md files on your disk — not in a proprietary database. You can edit them in any editor, back them up with any tool, and read them in ten years without memrynote installed. Front-matter properties, wiki-links, and backlinks all travel with the files, so your vault is never locked to one app.'
      },
      {
        heading: 'Tasks, calendar, and journal without plugins',
        body: 'In Obsidian, task management, a calendar view, and daily journaling come from community plugins you install, configure, and debug. In memrynote they are native: a multi-view task system, a calendar that understands your due dates and journal entries, and a daily journal with day context. One app, no plugin tax, nothing to break on the next update.'
      },
      {
        heading: 'End-to-end encrypted sync, included',
        body: 'Obsidian Sync is a separate paid add-on. memrynote includes zero-knowledge, end-to-end encrypted sync built on XChaCha20-Poly1305 — the server only ever holds ciphertext, and your keys never leave your devices. Local use is free forever; sync is an optional upgrade, not a wall in front of your own notes.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: 'Free for personal use. Obsidian Sync from ~$4/mo; commercial use $50/yr.'
    },
    whenCompetitorWins:
      'Obsidian is the better pick if you want the largest plugin ecosystem in note-taking, a mature mobile app today, or a very specific community plugin for a niche workflow. memrynote trades that breadth for a complete, built-in workspace you do not have to assemble yourself.',
    migration: {
      importer: null,
      steps: [
        'Point memrynote at your existing Obsidian vault folder — both store plain Markdown, so there is nothing to convert.',
        'Wiki-links, backlinks, and front-matter properties carry over as-is.',
        'Optionally turn on end-to-end encrypted sync to share the vault across your devices.'
      ]
    },
    faqs: [
      {
        question: 'Can memrynote open my existing Obsidian vault?',
        answer:
          'Yes. memrynote reads plain Markdown folders directly, so you can point it at your current Obsidian vault without converting or importing anything. Wiki-links and backlinks keep working.'
      },
      {
        question: 'Does memrynote support Obsidian plugins?',
        answer:
          'No — memrynote is not plugin-based. The features people most commonly add via plugins (tasks, calendar, journal, inbox) are built in as native features, so there is nothing to install or maintain.'
      },
      {
        question: 'Is memrynote free like Obsidian?',
        answer:
          'Yes. memrynote is free for local use, with no commercial-use license required. Optional end-to-end encrypted sync starts at $5/mo if you want to sync across devices.'
      },
      {
        question: 'Is there a mobile app?',
        answer:
          'memrynote is a desktop app for macOS, Windows, and Linux today. Because your vault is plain Markdown in a folder you own, the files stay readable and editable on any device or app.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'notionAlternative',
    competitor: 'Notion',
    eyebrow: 'Private Notion alternative',
    heading: 'The private Notion alternative that',
    headingAccent: 'can’t read your notes.',
    intro:
      'memrynote is a private, end-to-end encrypted alternative to Notion. Where Notion stores your pages on its servers — where staff can technically access them — memrynote keeps every note as a plain Markdown file on your own device and encrypts sync with XChaCha20-Poly1305, so the server only ever holds ciphertext. It combines notes, tasks, a calendar, and a daily journal in one offline-first workspace, runs on macOS, Windows, and Linux, and needs no account to get started. It is open source and free for local use, so your second brain stays yours even if the company disappears.',
    rows: [
      { feature: 'Local-first & offline', memry: true, competitor: false },
      { feature: 'End-to-end encryption', memry: true, competitor: false },
      { feature: 'Plain Markdown files', memry: true, competitor: false },
      { feature: 'Works offline', memry: true, competitor: 'partial' },
      { feature: 'Built-in tasks', memry: true, competitor: true },
      { feature: 'Daily journal', memry: true, competitor: 'partial' },
      { feature: 'No vendor access to your data', memry: true, competitor: false },
      { feature: 'Open source', memry: true, competitor: false },
      { feature: 'Free tier', memry: true, competitor: 'partial' }
    ],
    reasons: [
      {
        title: 'Truly private',
        body: 'Your notes are encrypted on your device before sync. The server holds ciphertext and never sees your keys.'
      },
      {
        title: 'Your data, your files',
        body: 'Notes are plain Markdown in a folder you control — not blocks locked inside a proprietary database.'
      },
      {
        title: 'Offline-first',
        body: 'The whole workspace works without internet. Sync is an option, not a requirement.'
      },
      {
        title: 'No lock-in',
        body: 'Open source and Markdown-native, so you can leave any time with everything intact.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a private Notion alternative?',
        body: 'Yes. memrynote is an end-to-end encrypted, local-first alternative to Notion. Where Notion stores your pages on its servers in a form staff can technically access, memrynote keeps every note as a plain Markdown file on your device and encrypts sync so the server only holds ciphertext. You get notes, tasks, a calendar, and a daily journal in one offline-first workspace — open source, with no account required to start.'
      },
      {
        heading: 'Your notes as files, not blocks in a database',
        body: 'Notion locks your content into a proprietary block database you can only fully use inside Notion. memrynote stores plain Markdown files in a folder you control, so you can edit, back up, search, and move them with any tool. Export is not a recovery step — your notes already live as portable files on your own disk.'
      },
      {
        heading: 'End-to-end encryption Notion does not offer',
        body: 'Notion does not provide end-to-end encryption; its servers can read your workspace. memrynote encrypts every note on your device with XChaCha20-Poly1305 before it syncs, using zero-knowledge keys that never reach the server. If memrynote disappeared tomorrow, your decrypted notes would still be sitting on your machine.'
      },
      {
        heading: 'Works offline, no account required',
        body: 'Notion is cloud-first and degrades without a connection. memrynote is offline-first: the entire workspace — notes, tasks, calendar, journal, search — runs locally with no login. Sync is an option you switch on, not a requirement for opening your own notes.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: 'Free personal tier; paid plans from $10/user/mo.'
    },
    whenCompetitorWins:
      'Notion is the better pick for teams that need real-time multiplayer editing, relational databases, and shared wikis with many collaborators. memrynote is built for a private, single-person second brain — if your priority is collaboration over privacy and ownership, Notion fits better.',
    migration: {
      importer: 'Notion',
      steps: [
        'In Notion, export your workspace as “Markdown & CSV”.',
        'Open memrynote → Settings → Import and choose the Notion importer.',
        'Pages import as Markdown notes and databases as structured notes, landing in a folder you own.'
      ]
    },
    faqs: [
      {
        question: 'Can I import my Notion workspace?',
        answer:
          'Yes. Export your Notion workspace as Markdown & CSV, then use memrynote’s built-in Notion importer. Pages become Markdown notes and databases become structured notes in your local vault.'
      },
      {
        question: 'Is memrynote end-to-end encrypted? Is Notion?',
        answer:
          'memrynote is end-to-end encrypted: notes are encrypted on your device and the server only stores ciphertext. Notion does not offer end-to-end encryption — its servers can read your content.'
      },
      {
        question: 'Does memrynote work offline?',
        answer:
          'Yes. memrynote is offline-first. Every feature works with no connection and no account; sync across devices is an optional, encrypted upgrade.'
      },
      {
        question: 'Is memrynote free?',
        answer:
          'Yes — local use is free forever and open source. Optional encrypted sync starts at $5/mo.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'noteplanAlternative',
    competitor: 'NotePlan',
    eyebrow: 'NotePlan alternative',
    heading: 'The cross-platform NotePlan alternative for',
    headingAccent: 'Windows, macOS & Linux.',
    intro:
      'memrynote is a cross-platform alternative to NotePlan that brings notes, tasks, a calendar, and a daily journal together in one local-first app. Unlike NotePlan, which is built around Apple platforms, memrynote runs natively on macOS, Windows, and Linux. Notes are plain Markdown files in a folder you own, sync is end-to-end encrypted with zero-knowledge keys, and the app works fully offline without an account. It keeps the daily-notes, task-backlink, and calendar workflow that NotePlan users rely on — without locking you into a single operating system — and it is open source and free for local use.',
    rows: [
      { feature: 'macOS support', memry: true, competitor: true },
      { feature: 'Windows support', memry: true, competitor: false },
      { feature: 'Linux support', memry: true, competitor: false },
      { feature: 'Plain Markdown files', memry: true, competitor: true },
      { feature: 'Notes + tasks + calendar', memry: true, competitor: true },
      { feature: 'Daily journal', memry: true, competitor: true },
      { feature: 'End-to-end encrypted sync', memry: true, competitor: false },
      { feature: 'Open source', memry: true, competitor: false },
      { feature: 'Free tier', memry: true, competitor: 'partial' }
    ],
    reasons: [
      {
        title: 'Cross-platform',
        body: 'Native on Windows and Linux too — not just Apple devices — so your workspace follows you everywhere.'
      },
      {
        title: 'Encrypted by default',
        body: 'Zero-knowledge end-to-end encrypted sync, instead of relying on plain iCloud storage.'
      },
      {
        title: 'Same daily-notes flow',
        body: 'Daily notes, task backlinks, and calendar scheduling — the workflow you already know.'
      },
      {
        title: 'Open source',
        body: 'Markdown files you own and an open codebase, so nothing about your notes is a black box.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a cross-platform NotePlan alternative?',
        body: 'Yes. memrynote brings NotePlan’s daily-notes, task, and calendar workflow to macOS, Windows, and Linux. NotePlan is built around Apple platforms; memrynote runs natively on all three desktop operating systems, stores notes as plain Markdown in a folder you own, and syncs with zero-knowledge end-to-end encryption instead of relying on iCloud. It works fully offline and needs no account.'
      },
      {
        heading: 'The daily-notes and task workflow you already know',
        body: 'memrynote keeps the rhythm NotePlan users rely on: a daily note for each day, tasks that link back to where they came from, and a calendar that shows your scheduled work. Notes are Markdown, tasks are first-class, and the calendar understands due and start dates — so switching does not mean relearning how you plan your day.'
      },
      {
        heading: 'Runs on Windows and Linux, not just Apple',
        body: 'NotePlan’s apps live in the Apple ecosystem. If you use a Windows PC at work or Linux at home, memrynote follows you across all of them with the same vault and the same workflow. Your notes are portable Markdown files, so no single operating system owns your second brain.'
      },
      {
        heading: 'Encrypted sync without iCloud lock-in',
        body: 'NotePlan leans on iCloud for sync, which ties you to Apple’s storage. memrynote syncs with its own zero-knowledge, end-to-end encrypted layer — XChaCha20-Poly1305, keys that never leave your devices — so the server only sees ciphertext and your sync is not bound to one platform.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: 'Subscription from ~$7/mo (no free tier for full features).'
    },
    whenCompetitorWins:
      'NotePlan is the better pick if you live entirely inside the Apple ecosystem and want deep Apple Calendar and Reminders integration plus a polished iPhone and iPad app today. memrynote’s advantage is cross-platform reach and encrypted, platform-independent sync.',
    migration: {
      importer: null,
      steps: [
        'Find your NotePlan Markdown folder (Notes and Calendar notes are plain .md files).',
        'Point memrynote at that folder — daily notes and tasks carry over as Markdown.',
        'Enable encrypted cross-platform sync to use the same vault on Windows, macOS, and Linux.'
      ]
    },
    faqs: [
      {
        question: 'Does memrynote run on Windows and Linux?',
        answer:
          'Yes. memrynote is native on macOS, Windows, and Linux, unlike NotePlan, which is focused on Apple platforms.'
      },
      {
        question: 'Can I keep my NotePlan daily-notes workflow?',
        answer:
          'Yes. memrynote has the same daily-note, task-backlink, and calendar workflow, so your planning habits carry over.'
      },
      {
        question: 'Can memrynote read my NotePlan Markdown files?',
        answer:
          'Yes. NotePlan stores notes as Markdown, and memrynote opens Markdown folders directly, so you can point it at your existing notes.'
      },
      {
        question: 'Is sync encrypted?',
        answer:
          'Yes. memrynote syncs with zero-knowledge, end-to-end encryption, so the server only ever stores ciphertext — no iCloud dependency.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'capacitiesAlternative',
    competitor: 'Capacities',
    eyebrow: 'Capacities alternative',
    heading: 'The local-first Capacities alternative with',
    headingAccent: 'open Markdown files, not a cloud database.',
    intro:
      'memrynote is a local-first alternative to Capacities that keeps every note as a plain Markdown file in a folder you own — no proprietary object database, no cloud lock-in. Where Capacities organises knowledge as typed objects stored on its servers, memrynote stores portable .md files on your disk, syncs with zero-knowledge end-to-end encryption, and works fully offline without an account. Notes, tasks, a calendar, a daily journal, and an inbox are all built in as first-class features in one connected workspace, not scattered across separate views. Your notes stay as open text you can edit and back up with any tool. memrynote runs on macOS, Windows, and Linux, is open source, and is free for local use.',
    rows: [
      { feature: 'Local Markdown files you own', memry: true, competitor: false },
      { feature: 'Works fully offline', memry: true, competitor: false },
      { feature: 'End-to-end encrypted sync', memry: true, competitor: false },
      { feature: 'Built-in tasks & projects', memry: true, competitor: 'partial' },
      { feature: 'Built-in calendar', memry: true, competitor: 'partial' },
      { feature: 'Daily journal / daily notes', memry: true, competitor: true },
      { feature: 'Mobile app', memry: false, competitor: true },
      { feature: 'Open source', memry: true, competitor: false },
      { feature: 'No account required', memry: true, competitor: false }
    ],
    reasons: [
      {
        title: 'Files you own',
        body: 'Notes are plain Markdown in a folder you control — not typed objects locked in a proprietary cloud database.'
      },
      {
        title: 'Offline-first',
        body: 'The entire workspace — notes, tasks, calendar, journal — works with no internet connection and no account.'
      },
      {
        title: 'Encrypted sync',
        body: 'Zero-knowledge end-to-end encryption, so the server only holds ciphertext and your keys never leave your devices.'
      },
      {
        title: 'One complete workspace',
        body: 'Tasks, calendar, daily journal, and inbox are built-in native features, not separate services to manage.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good Capacities alternative?',
        body: 'Yes. memrynote is a local-first Capacities alternative that keeps every note as a plain Markdown file in a folder you own, rather than as typed objects in a cloud database. Notes, tasks, a calendar, a daily journal, and an inbox are built in as first-class features in one offline-first app. It runs on macOS, Windows, and Linux, syncs with zero-knowledge end-to-end encryption, and needs no account to start.'
      },
      {
        heading: 'Your notes as Markdown files, not a proprietary object store',
        body: 'Capacities organises knowledge as typed objects — notes, books, people — stored in its cloud. That model is powerful for database-style thinking, but your content lives on its servers in a format you do not directly control. memrynote stores every note as a plain .md file on your disk. You can open, search, back up, and move those files with any tool, and your notes are portable text you own from day one.'
      },
      {
        heading: 'Tasks, calendar, and journal without a cloud dependency',
        body: 'Capacities adds due dates to objects and has daily notes, but it does not ship a dedicated task system with Kanban, custom statuses, subtasks, and recurring tasks. memrynote does. Its native task layer connects to a calendar that understands due dates, start dates, and journal entries — all running locally, synced optionally with end-to-end encryption. One app covers the full planning loop.'
      },
      {
        heading: 'End-to-end encrypted sync, not cloud-stored objects',
        body: 'Capacities syncs through its cloud without end-to-end encryption, which means the service can read your notes. memrynote encrypts every note on your device with XChaCha20-Poly1305 before it leaves your machine, using zero-knowledge keys the server never receives. The server stores only ciphertext, and sync is optional — never a requirement to access your own notes.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: 'Free tier available; Pro ~$9.99/mo (as of mid-2026).'
    },
    whenCompetitorWins:
      'Capacities is the better pick if you want a mobile app on iOS and Android today, a flexible object-type system for modelling people, books, and custom knowledge types, or a built-in AI writing assistant. Its visual, database-style interface suits users who prefer organising knowledge as typed objects rather than plain-text notes.',
    migration: {
      importer: null,
      steps: [
        'In Capacities, export your space as Markdown from the space settings or export menu.',
        'Point memrynote at the folder of exported .md files — your notes and internal links carry over as plain text.',
        'Optionally enable end-to-end encrypted sync to access the same vault across your devices.'
      ]
    },
    faqs: [
      {
        question: 'Can I migrate my Capacities notes to memrynote?',
        answer:
          'Yes. Export your Capacities space as Markdown from the space settings, then point memrynote at the resulting folder. Your notes carry over as plain .md files with no extra conversion.'
      },
      {
        question: 'Is Capacities end-to-end encrypted?',
        answer:
          'No. Capacities syncs your knowledge base through its cloud without end-to-end encryption, so the service can read your content. memrynote encrypts everything on your device with XChaCha20-Poly1305 and zero-knowledge keys — the server only ever stores ciphertext.'
      },
      {
        question: 'Does memrynote work offline like a desktop app?',
        answer:
          'Yes. memrynote is offline-first: the full workspace — notes, tasks, calendar, journal — runs locally with no internet connection and no account. Sync is an optional encrypted upgrade.'
      },
      {
        question: 'Does memrynote have a mobile app like Capacities?',
        answer:
          'Not yet. memrynote is a desktop app for macOS, Windows, and Linux today. Because your vault is plain Markdown in a folder you own, the files remain readable and editable on any device in the meantime.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'evernoteAlternative',
    competitor: 'Evernote',
    eyebrow: 'Evernote alternative',
    heading: 'The private Evernote alternative with',
    headingAccent: 'end-to-end encryption and no note limits.',
    intro:
      'memrynote is a private, local-first alternative to Evernote. Where Evernote stores all your notes on its servers in a proprietary format, memrynote keeps every note as a plain Markdown file on your device and encrypts sync with XChaCha20-Poly1305 so the server only ever holds ciphertext. It combines notes, tasks, a calendar, a daily journal, and an inbox in one offline-first workspace, runs on macOS, Windows, and Linux, and needs no account to get started. Evernote’s free tier limits you to 50 notes on one device; memrynote’s local vault is free forever with no note limit and no device restriction. It is open source, and your notes are portable Markdown files you can read anywhere, without memrynote installed.',
    rows: [
      { feature: 'Local-first, offline, no account required', memry: true, competitor: false },
      { feature: 'End-to-end encryption', memry: true, competitor: false },
      { feature: 'Plain Markdown files you own', memry: true, competitor: false },
      { feature: 'Unlimited free notes (no tier cap)', memry: true, competitor: false },
      { feature: 'Built-in tasks, projects & calendar', memry: true, competitor: 'partial' },
      { feature: 'Daily journal', memry: true, competitor: false },
      { feature: 'Mobile apps (iOS & Android)', memry: false, competitor: true },
      { feature: 'Web clipper & OCR', memry: 'partial', competitor: true },
      { feature: 'Open source', memry: true, competitor: false }
    ],
    reasons: [
      {
        title: 'Your notes, your files',
        body: 'Notes are plain Markdown in a folder you control — not locked in Evernote’s format or held behind a subscription tier.'
      },
      {
        title: 'Zero-knowledge encryption',
        body: 'Every note is encrypted on your device before sync. The server holds ciphertext and never sees your keys.'
      },
      {
        title: 'Tasks, calendar & journal built in',
        body: 'A full task system, calendar, daily journal, and inbox are native features, not bolt-on extras you pay more for.'
      },
      {
        title: 'Free without limits',
        body: 'The local vault is free forever with no note cap, no device limit, and no account.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good Evernote alternative?',
        body: 'Yes. memrynote is a private, local-first Evernote alternative that stores every note as a plain Markdown file you own and encrypts sync so the server never sees your content. Where Evernote’s free tier caps you at 50 notes on one device and locks notes in its own format, memrynote’s local vault is free forever with no limits and no account required. It adds tasks, a calendar, a daily journal, and an inbox to the notes workflow Evernote started.'
      },
      {
        heading: 'Your notes as Markdown files, not Evernote’s database',
        body: 'Evernote stores notes in ENML, its own XML-based format, which means your notes only truly live inside Evernote. memrynote stores every note as a plain .md file in a folder you control. You can open, edit, back up, and move notes with any text editor. There is no export step to recover your own content — the files are already on your disk, readable in any app, on any operating system.'
      },
      {
        heading: 'Notes, tasks, and calendar in one app',
        body: 'Evernote is built around note capture; task management is a limited add-on and there is no built-in calendar or daily journal. memrynote ships tasks with projects, custom statuses, subtasks, recurring tasks, and Kanban, list, and calendar views as native features. A daily journal and an inbox with web clips, voice capture, and PDF extraction are built in too.'
      },
      {
        heading: 'End-to-end encryption Evernote doesn’t offer',
        body: 'Evernote encrypts data at rest and in transit, but it is not end-to-end encrypted — Evernote can read your notes. memrynote encrypts every note on your device with XChaCha20-Poly1305 before sync, using zero-knowledge keys that never reach the server. Local use needs no account, no subscription, and no connection to any server.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: 'Free (50 notes, 1 device); paid plans from ~$8.25/mo annually (as of mid-2026).'
    },
    whenCompetitorWins:
      'Evernote is the better pick if you need polished iOS and Android apps with offline access, a best-in-class web clipper, or OCR that searches text inside images and scans. It also wins on ecosystem integrations and email-to-note capture. memrynote’s advantages are privacy, ownership, and a broader built-in workspace; it does not yet have a mobile app.',
    migration: {
      importer: 'Evernote',
      steps: [
        'In Evernote, choose File → Export and export your notes as Evernote XML (.enex).',
        'Open memrynote → Settings → Import, choose the Evernote importer, and select your .enex file.',
        'Notes land as plain Markdown files in your local vault with attachments preserved, ready to read offline.'
      ]
    },
    faqs: [
      {
        question: 'Can I import my Evernote notes into memrynote?',
        answer:
          'Yes. Export your notes from Evernote as an .enex file, then open memrynote → Settings → Import and choose the Evernote importer. Notes land as plain Markdown files with attachments preserved.'
      },
      {
        question: 'Is memrynote end-to-end encrypted? Is Evernote?',
        answer:
          'memrynote is end-to-end encrypted: notes are encrypted on your device and the server only holds ciphertext. Evernote encrypts data at rest and in transit but is not end-to-end encrypted, so Evernote can read your notes.'
      },
      {
        question: 'Does memrynote have a mobile app like Evernote?',
        answer:
          'Not yet — memrynote is a desktop app for macOS, Windows, and Linux today. Because your vault is plain Markdown in a folder you own, the files stay readable and editable on any device while the mobile app is in development.'
      },
      {
        question: 'Does memrynote limit how many notes I can store for free?',
        answer:
          'No. memrynote’s local vault is free forever with no note limit. Evernote’s free tier caps you at 50 notes on one device, as of mid-2026.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'logseqAlternative',
    competitor: 'Logseq',
    eyebrow: 'Logseq alternative',
    heading: 'The Logseq alternative with',
    headingAccent: 'tasks, a calendar & encrypted sync built in.',
    intro:
      'memrynote is a local-first alternative to Logseq that keeps your notes as plain Markdown files in a folder you own, with wiki-links and backlinks connecting your graph — no block database required. Where Logseq’s outliner model makes every line a block, memrynote uses a document-first editing experience you can jump into without learning a new paradigm. Tasks, a calendar, a daily journal, and an inbox are built in as first-class features rather than assembled from plugins. End-to-end encrypted sync ships as part of the product — XChaCha20-Poly1305, zero-knowledge keys — instead of relying on iCloud or Dropbox. memrynote runs on macOS, Windows, and Linux, works fully offline without an account, and is open source.',
    rows: [
      { feature: 'Local Markdown files you own', memry: true, competitor: true },
      { feature: 'Wiki-links & backlinks', memry: true, competitor: true },
      { feature: 'Built-in task management', memry: true, competitor: 'partial' },
      { feature: 'Built-in calendar view', memry: true, competitor: false },
      { feature: 'Daily journal', memry: true, competitor: true },
      { feature: 'Inbox / quick capture', memry: true, competitor: false },
      { feature: 'End-to-end encrypted sync included', memry: true, competitor: 'partial' },
      { feature: 'Mobile app', memry: false, competitor: 'partial' },
      { feature: 'Open source', memry: true, competitor: true }
    ],
    reasons: [
      {
        title: 'No plugin setup',
        body: 'Tasks, a calendar, a daily journal, and an inbox are native features — what Logseq delegates to plugins and block workarounds is built in.'
      },
      {
        title: 'Document-first editing',
        body: 'Write flowing notes with headings, paragraphs, and tables rather than forcing every idea into a nested bullet hierarchy.'
      },
      {
        title: 'Encryption included',
        body: 'Zero-knowledge, end-to-end encrypted sync is part of the product — no reliance on iCloud, Dropbox, or plain-text Git remotes.'
      },
      {
        title: 'Open & cross-platform',
        body: 'Open source on macOS, Windows, and Linux, with notes stored as portable Markdown you can read in any editor.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good Logseq alternative?',
        body: 'Yes. memrynote is a local-first Logseq alternative that preserves the networked-thought core — plain Markdown files, wiki-links, and backlinks — while adding tasks, a calendar, a daily journal, and an inbox as built-in first-class features. Where Logseq requires plugins or block-based workarounds to fill these gaps, memrynote ships them natively. It runs on macOS, Windows, and Linux, works fully offline, and includes zero-knowledge end-to-end encrypted sync as an optional upgrade.'
      },
      {
        heading: 'Document-first notes, not outliner-only blocks',
        body: 'Logseq’s block model means every sentence is a node in a hierarchy — powerful for graph-style thinking, but unfamiliar if you want to write flowing documents. memrynote is document-first: headings, paragraphs, code blocks, and tables work naturally without forcing everything into nested bullets. Wiki-links and front-matter properties still connect your notes into a graph, so the networked-thought foundation carries over.'
      },
      {
        heading: 'Tasks, calendar, and inbox without plugin setup',
        body: 'Logseq handles tasks through TODO/DONE block states and community plugins; there is no native task system with projects, subtasks, or multi-view scheduling. memrynote ships a full task manager — projects, custom statuses, subtasks, recurring tasks, and Kanban, Calendar, and List views — alongside a daily journal and an inbox for quick capture. Nothing requires a plugin.'
      },
      {
        heading: 'Encrypted sync that doesn’t need iCloud or Dropbox',
        body: 'Logseq users typically sync for free via iCloud, Dropbox, or Git — none end-to-end encrypted — or pay for Logseq Sync. memrynote includes zero-knowledge, end-to-end encrypted sync built on XChaCha20-Poly1305: your keys never leave your devices and the server stores only ciphertext, on every operating system. Local use is always free; encrypted sync is an optional upgrade.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor:
        'Free and open source for local use; Logseq Sync ~$5/mo (E2E encrypted), as of mid-2026.'
    },
    whenCompetitorWins:
      'Logseq is the better pick if the outliner block model is how you naturally think — every bullet a first-class node with its own properties and back-references. It is entirely free for local use with no paid tier for core features, has a large community plugin ecosystem, and ships a mobile app. If block-graph depth and zero cost matter most, Logseq wins.',
    migration: {
      importer: null,
      steps: [
        'Open Logseq, click the graph name, and choose Open graph folder — all notes are plain .md files inside it.',
        'Point memrynote at that folder — wiki-links, backlinks, and daily journal pages carry over as Markdown with no conversion.',
        'Optionally enable end-to-end encrypted sync to keep the vault in sync across your devices.'
      ]
    },
    faqs: [
      {
        question: 'Can memrynote open my existing Logseq graph folder?',
        answer:
          'Yes. Logseq’s file version stores all notes as plain .md files in a folder on your machine. Point memrynote at that folder and wiki-links, backlinks, and daily journal pages work immediately — no import or conversion needed.'
      },
      {
        question: 'Does memrynote support Logseq’s block-outliner model?',
        answer:
          'memrynote is document-first rather than block-first. You write flowing notes with headings and paragraphs instead of nested bullet hierarchies. Wiki-links and backlinks still connect your graph, so networked-thought transfers — the editing paradigm is intentionally different.'
      },
      {
        question: 'Is memrynote free like Logseq?',
        answer:
          'Yes. memrynote is free for local use, open source, and needs no account. Optional end-to-end encrypted sync starts at $5/mo.'
      },
      {
        question: 'Does memrynote have a mobile app like Logseq?',
        answer:
          'Not yet. memrynote is a desktop app for macOS, Windows, and Linux today. Because your vault is plain Markdown in a folder you own, the files stay readable in any Markdown app on mobile in the meantime.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'anytypeAlternative',
    competitor: 'Anytype',
    eyebrow: 'Anytype alternative',
    heading: 'The Anytype alternative with',
    headingAccent: 'open Markdown files and a built-in workspace.',
    intro:
      'memrynote and Anytype share the same foundation: both are local-first, end-to-end encrypted, open-source apps that work offline without sending plaintext to a server. The difference is the file layer and the built-in toolset. Anytype stores everything in a proprietary object database only Anytype can read; memrynote stores every note as a plain Markdown file in a folder you control — open in any editor, versionable with git, and readable years from now without the app installed. memrynote also ships a complete daily workspace out of the box: notes with wiki-links and backlinks, tasks with projects and Kanban views, a calendar, a daily journal, and a capture inbox. It runs on macOS, Windows, and Linux, is open source, and is free for local use, with optional zero-knowledge encrypted sync.',
    rows: [
      { feature: 'Local-first & offline', memry: true, competitor: true },
      { feature: 'End-to-end encryption', memry: true, competitor: true },
      { feature: 'Open source', memry: true, competitor: true },
      { feature: 'Open plain Markdown files', memry: true, competitor: false },
      { feature: 'Mobile app (iOS & Android)', memry: false, competitor: true },
      { feature: 'Built-in task management', memry: true, competitor: 'partial' },
      { feature: 'Built-in calendar & daily journal', memry: true, competitor: 'partial' },
      { feature: 'Inbox / quick capture', memry: true, competitor: 'partial' },
      { feature: 'Real-time collaboration', memry: false, competitor: true }
    ],
    reasons: [
      {
        title: 'Open, portable files',
        body: 'Every note is a plain .md file in a folder you control — readable in any editor, versionable with git, never locked to a proprietary format.'
      },
      {
        title: 'Built-in daily workspace',
        body: 'Tasks, calendar, journal, and inbox are first-class features, not object types you configure and maintain yourself.'
      },
      {
        title: 'Zero-knowledge encrypted sync',
        body: 'XChaCha20-Poly1305 encryption with keys that never leave your devices — the server only ever stores ciphertext.'
      },
      {
        title: 'Free local vault, forever',
        body: 'Local use is free with no storage cap on your own disk. Encrypted sync is an optional upgrade.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good Anytype alternative?',
        body: 'Yes. memrynote is a strong Anytype alternative if you want open, portable notes and a complete daily workspace without configuration. Both apps are local-first and end-to-end encrypted, but memrynote stores every note as a plain Markdown file any editor can open, while Anytype uses a proprietary object database only Anytype reads. memrynote also ships tasks, a calendar, and a journal as first-class features, so you spend less time wiring object types and more time working.'
      },
      {
        heading: 'Open Markdown files versus Anytype’s object store',
        body: 'Anytype stores your content in a proprietary object protocol on disk — files only Anytype can parse. memrynote stores every note as a portable .md file in a folder you own, so you can open it in VS Code, iA Writer, a terminal, or any Markdown tool without an export step. Front-matter properties, wiki-links, and backlinks travel with the files, and your vault stays versionable with git.'
      },
      {
        heading: 'Tasks, calendar, and journal as first-class features',
        body: 'Anytype’s strength is a flexible object and relational model — you can build a task tracker, but it requires setting up object types, relations, and views yourself. memrynote ships task management, a calendar that understands due and start dates, a daily journal, and a capture inbox as dedicated, out-of-the-box features. One app covers your full daily workflow with no object-wiring required.'
      },
      {
        heading: 'Sync, encryption, and file portability compared',
        body: 'Both memrynote and Anytype encrypt data end-to-end before it leaves your device. Anytype uses peer-to-peer sync to route data directly between devices; memrynote uses its own zero-knowledge server, encrypting with XChaCha20-Poly1305 so the server stores only ciphertext. The bigger portability gap is the file layer: memrynote’s Markdown files are readable by any tool; Anytype’s object store requires the app to decode them.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: 'Free plan (~1 GB network storage); paid plans from ~$4/mo (as of mid-2026).'
    },
    whenCompetitorWins:
      'Anytype is the better pick if you want iOS and Android apps today, a rich object and relational model for building personal databases, or peer-to-peer sync that routes data directly between your devices without a central server. memrynote has no mobile app yet and is single-user only, so Anytype wins if mobile access or collaboration is a priority.',
    migration: {
      importer: null,
      steps: [
        'In Anytype, go to Space Settings → Export and choose Markdown to export your objects as .md files.',
        'Point memrynote at the exported folder — notes open immediately as plain Markdown with no conversion step.',
        'Optionally enable end-to-end encrypted sync to share the vault across your macOS, Windows, and Linux devices.'
      ]
    },
    faqs: [
      {
        question: 'Can I import my Anytype data into memrynote?',
        answer:
          'memrynote does not have a dedicated Anytype importer. Export your Anytype spaces as Markdown from Space Settings → Export, then point memrynote at the resulting folder. Your notes open immediately as plain .md files.'
      },
      {
        question: 'How are memrynote and Anytype different if both are local-first and encrypted?',
        answer:
          'Both store data locally and encrypt before syncing, so neither vendor reads your content. The key difference is the file layer: Anytype uses a proprietary object store only Anytype can read; memrynote uses plain Markdown files any tool can open. memrynote also bundles tasks, a calendar, and a journal as dedicated features.'
      },
      {
        question: 'Does memrynote have a mobile app like Anytype?',
        answer:
          'Not yet. memrynote is a desktop app for macOS, Windows, and Linux. Anytype has iOS and Android apps, a genuine advantage if mobile matters. Because memrynote notes are plain Markdown in a folder you own, you can read them on any device with a standard Markdown editor in the meantime.'
      },
      {
        question: 'Does Anytype use plain Markdown files?',
        answer:
          'No. Anytype stores content in its own object protocol on disk — a format only Anytype can parse. It can export to Markdown, but the working format is proprietary. memrynote stores every note as a plain .md file, readable outside the app without an export step.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'appleNotesAlternative',
    competitor: 'Apple Notes',
    eyebrow: 'Apple Notes alternative',
    heading: 'The Apple Notes alternative that',
    headingAccent: 'runs on Windows and Linux too.',
    intro:
      'memrynote is a cross-platform alternative to Apple Notes that stores every note as a plain Markdown file in a folder you own — not locked inside Apple’s ecosystem. Apple Notes is polished and free for iPhone and Mac users, but it is Apple-only, stores notes in a proprietary format you cannot easily read outside the app, and offers only basic checklists rather than a full task system. memrynote runs natively on macOS, Windows, and Linux, keeps notes as portable .md files, and bundles task management, a calendar, and a daily journal in one offline-first app. Sync is end-to-end encrypted with zero-knowledge keys that never reach the server. It is open source and free for local use — no Apple ID and no iCloud account required to start.',
    rows: [
      { feature: 'macOS support', memry: true, competitor: true },
      { feature: 'Windows & Linux support', memry: true, competitor: false },
      { feature: 'Plain Markdown files you own', memry: true, competitor: false },
      { feature: 'Built-in task management', memry: true, competitor: false },
      { feature: 'Built-in calendar view', memry: true, competitor: false },
      { feature: 'Daily journal', memry: true, competitor: false },
      { feature: 'End-to-end encrypted sync', memry: true, competitor: 'partial' },
      { feature: 'iPhone & iPad app', memry: false, competitor: true },
      { feature: 'Open source', memry: true, competitor: false }
    ],
    reasons: [
      {
        title: 'Cross-platform freedom',
        body: 'Runs natively on macOS, Windows, and Linux — your notes are not tied to Apple hardware or iCloud.'
      },
      {
        title: 'Files you own',
        body: 'Notes are plain Markdown on your disk, not locked in Apple’s proprietary format.'
      },
      {
        title: 'Real tasks & calendar',
        body: 'Full task management, Kanban boards, projects, and a calendar view — not just basic checklists.'
      },
      {
        title: 'Encrypted sync you control',
        body: 'Zero-knowledge end-to-end encryption: the server only ever holds ciphertext and your keys never leave your devices.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good Apple Notes alternative?',
        body: 'Yes. memrynote is a cross-platform, local-first alternative to Apple Notes that works on macOS, Windows, and Linux — not just Apple devices. Notes are stored as plain Markdown files in a folder you own, instead of locked in Apple’s proprietary format. On top of notes, memrynote includes built-in task management, a calendar, and a daily journal, all in one offline-first app that syncs with zero-knowledge end-to-end encryption. No Apple ID or iCloud account is required.'
      },
      {
        heading: 'Your notes as Markdown files, not Apple’s format',
        body: 'Apple Notes stores content in a proprietary format you cannot easily read, move, or edit outside the Apple ecosystem. memrynote keeps every note as a plain .md file on your disk — readable in any editor, backupable with any tool, and portable for decades without memrynote installed. Wiki-links, backlinks, and front-matter properties travel with the files. If you decide to leave, your notes are already waiting as human-readable text.'
      },
      {
        heading: 'Tasks, calendar, and journal Apple Notes doesn’t have',
        body: 'Apple Notes offers checklists, but no real task system: no due dates, no projects, no Kanban board, no recurring tasks. memrynote builds all of that in — multi-view task management with List, Kanban, and Calendar views, project statuses, subtasks, and a daily journal with day context. The calendar understands your due dates, start dates, and schedule in one unified view.'
      },
      {
        heading: 'Cross-platform — Windows and Linux too',
        body: 'Apple Notes is exclusive to Apple hardware — there is no native Windows or Linux app, only a limited browser view at iCloud.com. memrynote runs natively on macOS, Windows, and Linux with the same vault and the same workflow. Optional end-to-end encrypted sync works across all three platforms without requiring iCloud.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor:
        'Free with any Apple device; iCloud+ storage from $0.99/mo beyond the 5 GB free tier.'
    },
    whenCompetitorWins:
      'Apple Notes is the better pick if you live entirely within the Apple ecosystem and want tight iPhone, iPad, and Apple Pencil integration with a polished mobile app today. It is also free with any Apple device. memrynote’s advantage is cross-platform reach, plain-file ownership, a real task system, and encrypted sync that does not depend on iCloud.',
    migration: {
      importer: 'Apple Notes',
      steps: [
        'Open memrynote → Settings → Import and choose the Apple Notes importer.',
        'Grant the one-time macOS permission to read your local Apple Notes database when prompted.',
        'Select which folders to import; notes arrive as plain Markdown files in your vault, preserving folder structure.'
      ]
    },
    faqs: [
      {
        question: 'Can I import my Apple Notes into memrynote?',
        answer:
          'Yes. Open memrynote → Settings → Import and choose the Apple Notes importer. Grant the one-time macOS permission to read your Notes database, then select which folders to bring over. Notes arrive as plain Markdown files.'
      },
      {
        question: 'Is Apple Notes end-to-end encrypted?',
        answer:
          'Partially. Locked notes are end-to-end encrypted with your note password, and turning on Advanced Data Protection extends end-to-end encryption to all iCloud Notes. Standard iCloud Notes without it are not end-to-end encrypted. memrynote’s sync is always zero-knowledge end-to-end encrypted.'
      },
      {
        question: 'Does memrynote have an iPhone or iPad app?',
        answer:
          'Not yet — memrynote is a desktop app for macOS, Windows, and Linux today. Because your vault is plain Markdown in a folder you own, the files stay readable and editable on any device in the meantime.'
      },
      {
        question: 'Is Apple Notes free?',
        answer:
          'Apple Notes is free and pre-installed on Apple devices, drawing on your iCloud storage (5 GB free, larger plans from $0.99/mo as of mid-2026). memrynote is also free for local use, with no Apple device or iCloud account required.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'bearAlternative',
    competitor: 'Bear',
    eyebrow: 'Bear alternative',
    heading: 'The cross-platform Bear alternative with',
    headingAccent: 'tasks, a calendar & files you own.',
    intro:
      'memrynote is a cross-platform alternative to Bear for people who need more than a beautiful Apple-native writing app. Bear runs only on iPhone, iPad, and Mac, and stores notes in its own database rather than plain files you can open anywhere. memrynote runs natively on macOS, Windows, and Linux, saves every note as a Markdown file in a folder you own, and ships task management, a calendar, a daily journal, and an inbox as built-in features. Sync is end-to-end encrypted with XChaCha20-Poly1305 and zero-knowledge keys, so the server never holds readable data. Bear Pro costs ~$2.99/mo or ~$29.99/yr as of mid-2026; memrynote is free for local use, with optional encrypted sync from $5/mo. It is open source and works fully offline.',
    rows: [
      { feature: 'macOS support', memry: true, competitor: true },
      { feature: 'Windows & Linux support', memry: true, competitor: false },
      { feature: 'iPhone & iPad app', memry: false, competitor: true },
      { feature: 'Plain Markdown files you own', memry: true, competitor: false },
      { feature: 'Built-in task management', memry: true, competitor: false },
      { feature: 'Built-in calendar & daily journal', memry: true, competitor: false },
      { feature: 'End-to-end encrypted sync', memry: true, competitor: false },
      { feature: 'Inbox / quick capture', memry: true, competitor: 'partial' },
      { feature: 'Open source', memry: true, competitor: false }
    ],
    reasons: [
      {
        title: 'Cross-platform',
        body: 'Native on Windows and Linux too, not just Apple devices — your workspace follows you everywhere.'
      },
      {
        title: 'Files you own',
        body: 'Every note is a plain .md file in a folder you point to, readable in any editor right now, not locked in Bear’s database.'
      },
      {
        title: 'A complete workspace',
        body: 'Tasks, a calendar, a daily journal, and an inbox are built in, not features you add with separate apps.'
      },
      {
        title: 'Encrypted by default',
        body: 'Zero-knowledge, end-to-end encrypted sync — the server only ever holds ciphertext.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good Bear alternative?',
        body: 'Yes. memrynote covers the same note-taking core — Markdown editing, wiki-links, and backlinks — and adds built-in tasks, a calendar, and a daily journal that Bear does not offer. It runs on macOS, Windows, and Linux, so your workspace is not confined to Apple hardware. Bear remains the stronger choice if you rely on your iPhone or iPad for daily writing; otherwise memrynote delivers a broader toolkit with end-to-end encryption and plain files you control.'
      },
      {
        heading: 'Cross-platform: Windows and Linux too',
        body: 'Bear is available only on Apple devices — iPhone, iPad, and Mac. If you work on Windows or Linux, your notes are out of reach without a Mac. memrynote runs natively on all three major desktop platforms. Your vault is a folder of plain Markdown files that open in any text editor on any operating system, so your knowledge base follows your hardware, not the other way around.'
      },
      {
        heading: 'Plain Markdown files, not a database',
        body: 'Bear stores your notes in its own database. You can export to Markdown, but your notes do not live as portable files you can open without Bear installed. memrynote is the opposite: every note is a .md file in a folder you point to, readable in VS Code, Obsidian, or any text editor right now. Your knowledge base is yours unconditionally.'
      },
      {
        heading: 'Tasks and a calendar Bear leaves out',
        body: 'Bear is a focused writing app — no real task system, projects, or calendar. memrynote ships task management with projects, custom statuses, subtasks, and recurring tasks across Kanban, List, and Calendar views, plus a daily journal and a capture inbox. One app covers writing and planning instead of two.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: 'Free tier; Bear Pro ~$2.99/mo or ~$29.99/yr (as of mid-2026).'
    },
    whenCompetitorWins:
      'Bear is the better pick if you want a beautiful Apple-native writing experience with iPhone and iPad apps today, tight Apple ecosystem integration, and a focused, distraction-free editor. memrynote’s advantages are cross-platform reach, a built-in task and calendar workspace, plain-file ownership, and end-to-end encrypted sync; it has no mobile app yet.',
    migration: {
      importer: 'Bear',
      steps: [
        'In Bear, export your notes as a .bear2bk backup archive.',
        'Open memrynote → Settings → Import, choose the Bear importer, and select the .bear2bk file.',
        'Your notes and attachments arrive as plain Markdown files in your vault, ready to read offline.'
      ]
    },
    faqs: [
      {
        question: 'Can I import my Bear notes into memrynote?',
        answer:
          'Yes. Export a .bear2bk backup from Bear, then open memrynote → Settings → Import and choose the Bear importer. Your notes and attachments arrive as plain Markdown files in seconds for most libraries.'
      },
      {
        question: 'Does memrynote run on Windows and Linux?',
        answer:
          'Yes. memrynote is native on macOS, Windows, and Linux, unlike Bear, which is Apple-only. Your vault works the same on every platform.'
      },
      {
        question: 'Does memrynote store notes as plain files like Bear exports?',
        answer:
          'Yes — by default. Every note is a plain .md file in a folder you own, readable in any editor at any time. Bear keeps its working notes in its own database and only produces files on export.'
      },
      {
        question: 'Does memrynote have an iPhone app like Bear?',
        answer:
          'Not yet — memrynote is a desktop app for macOS, Windows, and Linux today. Because your vault is plain Markdown in a folder you own, the files stay readable on any device in the meantime.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'roamAlternative',
    competitor: 'Roam Research',
    eyebrow: 'Roam Research alternative',
    heading: 'The Roam Research alternative with',
    headingAccent: 'local Markdown files and no monthly lock-in.',
    intro:
      'memrynote is a local-first alternative to Roam Research that stores every note as a plain Markdown file in a folder you own, rather than in a proprietary cloud graph. Where Roam requires a paid subscription from day one, memrynote is free for local use forever, and optional sync starts at $5/mo with end-to-end encrypted storage so the server never sees your notes. It ships notes, tasks, a calendar, and a daily journal in one offline-first app on macOS, Windows, and Linux. Migrating is straightforward: export your Roam graph as Markdown and import it in memrynote. Roam remains the stronger choice for deep block references, datalog queries, and networked-thought density — but for local file ownership, affordability, and an integrated workspace, memrynote is the better fit.',
    rows: [
      { feature: 'Local Markdown files you own', memry: true, competitor: false },
      { feature: 'Works fully offline', memry: true, competitor: 'partial' },
      { feature: 'End-to-end encrypted sync', memry: true, competitor: false },
      { feature: 'Bi-directional links & backlinks', memry: true, competitor: true },
      { feature: 'Block references & graph queries', memry: 'partial', competitor: true },
      { feature: 'Real-time collaboration', memry: false, competitor: true },
      { feature: 'Built-in tasks, calendar & journal', memry: true, competitor: 'partial' },
      { feature: 'Free tier (local use)', memry: true, competitor: false },
      { feature: 'Open source', memry: true, competitor: false }
    ],
    reasons: [
      {
        title: 'Your files, not Roam’s database',
        body: 'Notes are plain .md files in a folder you choose, not a proprietary cloud graph you can only open inside Roam.'
      },
      {
        title: 'Free locally, affordable to sync',
        body: 'No subscription to get started, and encrypted sync from $5/mo when you want it — versus Roam’s monthly fee from day one.'
      },
      {
        title: 'Tasks, calendar & journal built in',
        body: 'Projects, Kanban, a calendar view, and a daily journal are native features, not block-syntax workarounds.'
      },
      {
        title: 'Encrypted & offline-first',
        body: 'Zero-knowledge sync and full offline use; the server only ever holds ciphertext.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good Roam Research alternative?',
        body: 'Yes. memrynote covers the core workflow — linked notes, backlinks, a daily journal, tasks, and a calendar — in a local-first app that costs nothing for offline use. Roam genuinely leads on deep block references and cross-document queries; if those are non-negotiable, Roam remains best in class. For everyone else, memrynote gives you portable Markdown files you own, zero-knowledge encrypted sync from $5/mo, and no subscription required to start.'
      },
      {
        heading: 'Your files, not Roam’s cloud database',
        body: 'Roam stores your knowledge graph in a proprietary cloud database, not flat files you can open elsewhere. memrynote writes every note as a .md file in a folder you choose, readable in any editor and portable across tools. Wiki-links and backlinks use standard Markdown syntax, so your graph stays yours.'
      },
      {
        heading: 'Free locally, no monthly lock-in',
        body: 'Roam Research costs ~$15/mo or ~$165/yr as of mid-2026, with no ongoing free tier beyond a trial. memrynote’s local vault is free forever — no account, no expiry, no internet required. When you need sync, plans start at $5/mo (Plus, 1 GB) or $10/mo (Pro, 10 GB), with a one-time Believer plan for long-term supporters.'
      },
      {
        heading: 'Tasks, calendar, and journal — all built in',
        body: 'Roam offers daily pages and basic TODO/DONE syntax but lacks a full project manager, Kanban board, calendar view, or recurring tasks. memrynote ships all of that as first-class features: projects with custom statuses, subtasks, Kanban and list views, and a calendar that surfaces due dates and journal entries — no plugin assembly.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: '~$15/mo or ~$165/yr; no ongoing free tier (as of mid-2026).'
    },
    whenCompetitorWins:
      'Roam Research is the better pick for power users who live in block references, datalog queries, and dense networked thought, or who need real-time collaboration on a shared graph. Its block-level granularity and query engine go deeper than memrynote’s document-and-wiki-link model. If that depth is the point, Roam wins.',
    migration: {
      importer: 'Roam',
      steps: [
        'In Roam, export your graph as Markdown (or JSON) from the export menu.',
        'Open memrynote → Settings → Import, choose the Roam importer, and select your export.',
        'Pages land as linked Markdown notes in your local vault, with backlinks preserved.'
      ]
    },
    faqs: [
      {
        question: 'Can I import my Roam graph into memrynote?',
        answer:
          'Yes. Export your Roam graph as Markdown or JSON, then open memrynote → Settings → Import and choose the Roam importer. Pages land as linked Markdown notes in a folder you own.'
      },
      {
        question: 'Is memrynote cheaper than Roam Research?',
        answer:
          'Yes for most users. memrynote is free for local use, while Roam costs ~$15/mo or ~$165/yr with no ongoing free tier as of mid-2026. memrynote’s optional encrypted sync starts at $5/mo.'
      },
      {
        question: 'Does memrynote support block references like Roam?',
        answer:
          'Partially. memrynote uses wiki-links and backlinks between notes rather than Roam’s granular block-level references and datalog queries. For networked thought it covers the core; for deep block querying, Roam goes further.'
      },
      {
        question: 'Are my notes stored locally with memrynote?',
        answer:
          'Yes. Every note is a plain .md file on your disk, and the app works fully offline. Roam stores your graph in its cloud. Optional memrynote sync is zero-knowledge end-to-end encrypted.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'onenoteAlternative',
    competitor: 'OneNote',
    eyebrow: 'OneNote alternative',
    heading: 'The OneNote alternative that',
    headingAccent: 'keeps your notes on your device.',
    intro:
      'memrynote is a private, local-first alternative to Microsoft OneNote. Where OneNote stores notebooks in OneDrive — tied to a Microsoft account and readable by Microsoft — memrynote keeps every note as a plain Markdown file on your device and encrypts sync end-to-end with XChaCha20-Poly1305, so the server only ever holds ciphertext. It combines notes, tasks, a calendar, and a daily journal in one offline-first workspace, runs on macOS, Windows, and Linux, and is open source. The local vault is free forever; sync starts at $5/mo. OneNote is free and leads where memrynote does not: freeform canvas pages with ink and handwriting, mobile apps, and deep Microsoft 365 integration. If those matter most, OneNote has the edge. If Markdown ownership, zero-knowledge privacy, and an integrated workflow matter more, memrynote is the better fit.',
    rows: [
      { feature: 'Plain Markdown files you own', memry: true, competitor: false },
      { feature: 'End-to-end encrypted sync', memry: true, competitor: false },
      { feature: 'Built-in tasks, calendar & journal', memry: true, competitor: 'partial' },
      { feature: 'Local-first & offline', memry: true, competitor: 'partial' },
      { feature: 'Open source', memry: true, competitor: false },
      { feature: 'Free tier', memry: true, competitor: true },
      { feature: 'Mobile apps (iOS & Android)', memry: false, competitor: true },
      { feature: 'Real-time collaboration', memry: false, competitor: true },
      { feature: 'Freeform canvas & ink / handwriting', memry: false, competitor: true }
    ],
    reasons: [
      {
        title: 'Your notes, not Microsoft’s',
        body: 'Notes live as plain .md files on your device, encrypted before sync — not in OneDrive where Microsoft can read them.'
      },
      {
        title: 'One integrated workspace',
        body: 'Notes, tasks, a calendar, and a daily journal in one app, instead of OneNote plus Microsoft To Do plus Outlook.'
      },
      {
        title: 'Private by design',
        body: 'Zero-knowledge end-to-end encryption; the sync server holds only ciphertext and never sees your keys.'
      },
      {
        title: 'Open & cross-platform',
        body: 'Open source on macOS, Windows, and Linux, with portable Markdown you can read in any editor.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good OneNote alternative?',
        body: 'Yes. memrynote replaces OneNote’s cloud-first notebooks with plain Markdown files you own, zero-knowledge encrypted sync, and a single workspace covering notes, tasks, a calendar, and a daily journal — all without a Microsoft account. It runs on macOS, Windows, and Linux. Honest caveat: OneNote is free, excels at freeform pages with ink and handwriting, has mature mobile apps, and integrates tightly with Microsoft 365. If those features matter most, they are reasons to keep OneNote.'
      },
      {
        heading: 'Your notes, not Microsoft’s',
        body: 'OneNote stores your notebooks in OneDrive, where Microsoft can technically read your content — it is not end-to-end encrypted. memrynote encrypts every note with XChaCha20-Poly1305 on your device before it leaves; the sync server holds only ciphertext and never sees your keys. Notes also live as plain .md files you can open in any text editor, so your data stays readable regardless of what happens to the service.'
      },
      {
        heading: 'One workspace: notes, tasks, calendar, journal',
        body: 'OneNote gives you freeform notebook pages and basic checkboxes; a real task system, calendar, or daily journal means adding Microsoft To Do, Outlook, or another app. memrynote builds all four into one offline-first workspace: Markdown notes with wiki-links and backlinks, projects with custom statuses and subtasks, a calendar that surfaces due dates and journal entries, and a quick-capture inbox.'
      },
      {
        heading: 'Migrating from OneNote',
        body: 'memrynote does not yet have a one-click OneNote importer — worth knowing before you switch. Migration is still doable: in the OneNote desktop app, export each notebook (for example as .docx or PDF), convert the pages to Markdown with a free tool such as Pandoc, then point memrynote at the folder of .md files as your vault. A native OneNote importer is on the roadmap.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: 'Free with a Microsoft account (uses OneDrive storage).'
    },
    whenCompetitorWins:
      'OneNote is the better pick if you want a free freeform canvas with ink and handwriting, mobile apps on every platform, real-time collaboration, or deep Microsoft 365 integration. memrynote’s advantages are Markdown ownership, zero-knowledge privacy, and an integrated notes-tasks-calendar-journal workflow; it has no mobile app or freeform canvas yet.',
    migration: {
      importer: null,
      steps: [
        'In the OneNote desktop app, export each notebook (for example as .docx or PDF).',
        'Convert the exported pages to Markdown with a free tool such as Pandoc.',
        'Point memrynote at the folder of .md files as your vault — your notes are ready to read offline.'
      ]
    },
    faqs: [
      {
        question: 'Can I import my OneNote notebooks into memrynote?',
        answer:
          'Not in one click yet — a native OneNote importer is on the roadmap. For now, export your notebooks from OneNote, convert the pages to Markdown with a free tool like Pandoc, and point memrynote at the resulting folder.'
      },
      {
        question: 'Is OneNote end-to-end encrypted?',
        answer:
          'No. OneNote stores notebooks in OneDrive with encryption in transit and at rest, but not end-to-end — Microsoft can technically read your content. memrynote encrypts every note on your device so the server only ever holds ciphertext.'
      },
      {
        question: 'Does memrynote need a Microsoft account?',
        answer:
          'No. memrynote works fully offline with no account at all. Optional encrypted sync uses your own memrynote account and is independent of Microsoft.'
      },
      {
        question: 'Does memrynote have mobile apps like OneNote?',
        answer:
          'Not yet — memrynote is a desktop app for macOS, Windows, and Linux today. Because your vault is plain Markdown in a folder you own, the files stay readable on any device in the meantime.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'upnoteAlternative',
    competitor: 'UpNote',
    eyebrow: 'UpNote alternative',
    heading: 'The UpNote alternative with',
    headingAccent: 'your notes as plain files, not a locked database.',
    intro:
      'memrynote is a local-first alternative to UpNote that stores every note as a plain Markdown file in a folder you choose — not inside UpNote’s proprietary database. Like UpNote, it works offline and costs nothing for a local vault. Unlike UpNote, your notes are actual .md files you can open in any text editor, move to Obsidian, or back up to any drive. Sync is end-to-end encrypted with XChaCha20-Poly1305, so the server never sees your content, whereas UpNote syncs with transport encryption only. memrynote also ships tasks, a calendar, a daily journal, and an inbox in one workspace, rather than limiting you to note-taking. It runs on macOS, Windows, and Linux, is open source, and works fully offline without an account.',
    rows: [
      { feature: 'Plain Markdown files you own', memry: true, competitor: false },
      { feature: 'End-to-end encrypted sync', memry: true, competitor: false },
      { feature: 'Mobile apps (iOS & Android)', memry: false, competitor: true },
      { feature: 'Built-in task management', memry: true, competitor: false },
      { feature: 'Built-in calendar', memry: true, competitor: false },
      { feature: 'Daily journal', memry: true, competitor: false },
      { feature: 'Works offline', memry: true, competitor: true },
      { feature: 'Open source', memry: true, competitor: false },
      { feature: 'Free tier (unlimited notes)', memry: true, competitor: 'partial' }
    ],
    reasons: [
      {
        title: 'Your files, your rules',
        body: 'Notes are plain .md files in a folder you own — readable in any editor, movable to any app, yours even if memrynote disappears.'
      },
      {
        title: 'Zero-knowledge sync',
        body: 'End-to-end encrypted before leaving your device. The sync server never sees your keys or content.'
      },
      {
        title: 'Notes, tasks, and calendar in one',
        body: 'Built-in task management, a calendar, a daily journal, and an inbox — no extra apps to stitch together.'
      },
      {
        title: 'Open source',
        body: 'Markdown files you own and an open codebase — nothing about your notes or sync is a black box.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good UpNote alternative?',
        body: 'Yes. If you want your notes as real .md files in a folder you control — not locked inside UpNote’s proprietary database — memrynote is the stronger fit. Every note is plain Markdown you can open in any editor, move to another app, or read without memrynote installed. You also get end-to-end encrypted sync, plus built-in tasks, a calendar, and a daily journal that UpNote does not offer.'
      },
      {
        heading: 'What happens to my notes if I stop using UpNote?',
        body: 'With UpNote, your notes live inside its own database and are accessible only through the app — you must export before leaving. With memrynote, your notes are already plain .md files on your drive. Open them in VS Code, iA Writer, Obsidian, or any plain-text viewer at any time. They will still be readable years from now without any app installed.'
      },
      {
        heading: 'Is memrynote’s sync more private than UpNote’s?',
        body: 'Yes. UpNote syncs with encryption in transit but no end-to-end protection, so the sync server can technically read your notes. memrynote encrypts every note with XChaCha20-Poly1305 before it leaves your device; the server holds only ciphertext and your keys never leave your machines. If you prefer no cloud at all, the app works fully offline.'
      },
      {
        heading: 'Does memrynote go beyond note-taking?',
        body: 'Yes — significantly. UpNote is a focused notes app with no built-in tasks, projects, or calendar. memrynote ships all three in one workspace: tasks with projects, custom statuses, subtasks, and recurring schedules across Kanban, List, and Calendar views, a daily journal tied to your calendar, and a quick-capture inbox for voice memos, web clips, and PDFs.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: 'Free up to 50 notes; Premium ~$1.99/mo or ~$39.99 lifetime (as of mid-2026).'
    },
    whenCompetitorWins:
      'UpNote is the better choice if you need iOS or Android apps — memrynote is desktop-only for now. Its lifetime plan is one of the cheapest in the category, and its sync is fast and effortless across all platforms with no configuration.',
    migration: {
      importer: null,
      steps: [
        'In UpNote, open Settings → Export and choose Markdown; UpNote saves each note as a .md file and mirrors your notebooks as folders.',
        'Open memrynote and point a new vault at the exported folder — memrynote reads .md files directly, with no import wizard.',
        'Confirm attachments: UpNote copies images alongside the .md files; set memrynote’s attachment folder to the same location.'
      ]
    },
    faqs: [
      {
        question: 'Can I import my UpNote notes into memrynote?',
        answer:
          'Yes. Export your notes from UpNote as Markdown (Settings → Export), then point a new memrynote vault at the exported folder. memrynote reads .md files directly without a conversion step.'
      },
      {
        question: 'Does UpNote support end-to-end encryption?',
        answer:
          'No. UpNote syncs with encryption in transit but not end-to-end, so the sync server can technically access your notes. memrynote uses XChaCha20-Poly1305 end-to-end encryption, so the server stores only ciphertext.'
      },
      {
        question: 'Does UpNote store my notes as files I can access outside the app?',
        answer:
          'No. UpNote keeps notes in its own database, not as plain files on your filesystem; you can export to Markdown but live data is not file-accessible. memrynote writes every note as a .md file to a folder you choose.'
      },
      {
        question: 'Does UpNote have task management or a calendar?',
        answer:
          'No. UpNote is a note-taking app with no built-in tasks, projects, or calendar. memrynote ships all three alongside notes, a daily journal, and an inbox in one workspace.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'joplinAlternative',
    competitor: 'Joplin',
    eyebrow: 'Joplin alternative',
    heading: 'The open-source Joplin alternative with',
    headingAccent: 'tasks, a calendar & a journal built in.',
    intro:
      'memrynote is a local-first, open-source alternative to Joplin that shares the same core ethos — Markdown notes, end-to-end encryption, and full offline access — while adding a built-in task manager, calendar, and daily journal in one cohesive app. Like Joplin, every note is written in Markdown and sync is zero-knowledge encrypted; unlike Joplin, tasks, a Kanban board, a calendar view, and a daily journal are first-class features rather than gaps you fill with plugins or separate tools. Notes live as plain .md files in a folder you choose, readable in any editor or version-control system. memrynote runs on macOS, Windows, and Linux, requires no account for local use, and is free forever for a single local vault, with optional end-to-end encrypted sync.',
    rows: [
      { feature: 'Open source', memry: true, competitor: true },
      { feature: 'End-to-end encrypted sync', memry: true, competitor: true },
      {
        feature: 'Notes as plain .md files in your own folder',
        memry: true,
        competitor: 'partial'
      },
      {
        feature: 'Built-in tasks (projects, Kanban, subtasks)',
        memry: true,
        competitor: 'partial'
      },
      { feature: 'Built-in calendar view', memry: true, competitor: false },
      { feature: 'Daily journal', memry: true, competitor: false },
      { feature: 'Inbox & quick capture', memry: true, competitor: 'partial' },
      { feature: 'Mobile apps (Android & iOS)', memry: false, competitor: true },
      { feature: 'Sync to Dropbox, WebDAV, or own server', memry: false, competitor: true }
    ],
    reasons: [
      {
        title: 'One cohesive workspace',
        body: 'Tasks, Kanban, a calendar, and a daily journal are built in — not gaps you patch with plugins or separate apps.'
      },
      {
        title: 'Your files, your folder',
        body: 'Notes are plain .md files in a folder you choose. Read them in any editor, grep them in a terminal, or version-control them with no export step.'
      },
      {
        title: 'Same open, encrypted core',
        body: 'Both apps are open source with zero-knowledge encrypted sync. memrynote adds a modern editor and a unified task-and-calendar layer.'
      },
      {
        title: 'Desktop-first, cross-platform',
        body: 'A polished native app for macOS, Windows, and Linux — no account required, fully offline from day one.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good Joplin alternative?',
        body: 'Yes. If you use Joplin for its open-source, end-to-end-encrypted Markdown workflow but wish tasks, a calendar, and a daily journal were built in, memrynote is a strong fit. Both apps store notes as Markdown, need no cloud account for local use, and encrypt sync with zero-knowledge keys. memrynote consolidates what Joplin handles through plugins and external tools into one cohesive workspace, with a modern editor and plain .md files in a vault folder you own.'
      },
      {
        heading: 'Does memrynote replace Joplin’s web clipper?',
        body: 'memrynote ships a built-in inbox with web clipping, voice capture, PDF extraction, and optional AI-assisted filing. The browser extension clips full pages, selections, or screenshots straight into your inbox queue, where you can file them as notes or tasks, tag them, and search them alongside everything else. Joplin’s clipper is mature and reliable; memrynote’s inbox is the equivalent integrated feature, with extra capture modes.'
      },
      {
        heading: 'Can I migrate my Joplin notes to memrynote?',
        body: 'Yes, in three steps. In Joplin, choose File → Export all → MD - Markdown + Front Matter; this produces a folder of .md files plus a resources subfolder. Copy that folder anywhere on your computer. Then open memrynote, choose Open vault, and select the folder — your notes, titles, tags, and attachments are read from the plain files immediately. No dedicated importer is needed.'
      },
      {
        heading: 'How does memrynote sync compare to Joplin’s?',
        body: 'Joplin can sync to Joplin Cloud, Dropbox, OneDrive, Nextcloud, or any WebDAV server — a broader set of backends than memrynote offers. memrynote provides its own end-to-end encrypted cloud rather than delegating to third-party storage. Both encrypt on the device before upload, so the server holds only ciphertext. If you must sync to your own Dropbox or self-hosted server, Joplin is the better fit today.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: 'App is free and open source; Joplin Cloud from ~€3/mo (as of mid-2026).'
    },
    whenCompetitorWins:
      'Joplin is the better choice if you need mobile apps — it has polished Android and iOS clients while memrynote is desktop-only for now. It also wins if you want to sync notes to Dropbox, OneDrive, or your own WebDAV or Nextcloud server, or if you rely on its large plugin ecosystem and long-established community.',
    migration: {
      importer: null,
      steps: [
        'In Joplin, choose File → Export all → MD - Markdown + Front Matter; Joplin writes each note as a .md file and copies attachments into a resources subfolder.',
        'Copy the exported folder to wherever you want your memrynote vault to live.',
        'In memrynote, choose Open vault and select that folder — notes, titles, tags, and attachments are read from the plain .md files immediately.'
      ]
    },
    faqs: [
      {
        question: 'Is Joplin free?',
        answer:
          'The Joplin app is free and open source on desktop and mobile, and sync is free if you use your own Dropbox, OneDrive, WebDAV, or filesystem. Joplin Cloud, the managed service, has paid tiers from ~€3/mo as of mid-2026.'
      },
      {
        question: 'Does Joplin have end-to-end encryption?',
        answer:
          'Yes. Joplin supports end-to-end encryption across all sync backends, enabled by a master password on each device. The sync server stores only ciphertext. memrynote is also end-to-end encrypted with zero-knowledge keys.'
      },
      {
        question: 'Does Joplin have mobile apps?',
        answer:
          'Yes. Joplin has official Android and iOS apps that support the same sync backends as desktop. This is a real advantage over memrynote, which is desktop-only (macOS, Windows, Linux) as of mid-2026.'
      },
      {
        question: 'Does memrynote have built-in task management Joplin lacks?',
        answer:
          'Yes. Joplin supports basic to-do items with due dates and alarms, but no projects, Kanban boards, subtasks, or recurring tasks. memrynote ships a full task-and-project workflow alongside your notes, calendar, and journal.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  },
  {
    pageKey: 'googleKeepAlternative',
    competitor: 'Google Keep',
    eyebrow: 'Google Keep alternative',
    heading: 'The Google Keep alternative with',
    headingAccent: 'notes, tasks & encryption you control.',
    intro:
      'memrynote is a private, local-first alternative to Google Keep that upgrades disposable sticky notes into a full second brain: Markdown notes with wiki-links and backlinks, task projects with Kanban and Calendar views, a daily journal, and an inbox — all in one desktop app on macOS, Windows, and Linux. Where Keep stores notes in your Google account and targets fast mobile capture, memrynote keeps every note as a plain .md file in a folder you own and encrypts sync with XChaCha20-Poly1305, so the server only ever holds ciphertext. Migrating is simple: export via Google Takeout and import in memrynote. If you rely on Google’s mobile apps, real-time sharing, or deep Google Calendar integration, Keep remains the easier path. For data ownership, zero-knowledge encryption, and a real note-taking workspace, memrynote is the upgrade.',
    rows: [
      { feature: 'Free to use', memry: 'partial', competitor: true },
      { feature: 'Mobile apps (iOS & Android)', memry: false, competitor: true },
      { feature: 'Local-first & offline', memry: true, competitor: 'partial' },
      { feature: 'Plain Markdown files you own', memry: true, competitor: false },
      { feature: 'End-to-end encrypted sync', memry: true, competitor: false },
      { feature: 'Built-in task management', memry: true, competitor: 'partial' },
      { feature: 'Calendar & daily journal', memry: true, competitor: false },
      { feature: 'Google ecosystem integration', memry: false, competitor: true },
      { feature: 'Open source', memry: true, competitor: false }
    ],
    reasons: [
      {
        title: 'Privacy by design',
        body: 'Notes are encrypted on your device before sync; the server holds only ciphertext, instead of living in your Google account.'
      },
      {
        title: 'A real workspace',
        body: 'Markdown notes, full task projects, a calendar, and a daily journal — not just colour-coded stickies and checklists.'
      },
      {
        title: 'Files you own',
        body: 'Every note is a plain .md file in a folder you control, readable in any editor and portable forever.'
      },
      {
        title: 'Open source',
        body: 'An open codebase you can audit, with no ads and no data mining of your notes.'
      }
    ],
    sections: [
      {
        heading: 'Is memrynote a good Google Keep alternative?',
        body: 'Yes. memrynote gives you what Google Keep lacks: real Markdown notes with wiki-links and backlinks, task projects with custom statuses and Kanban boards, a calendar that surfaces due dates and your daily journal, and an inbox for voice, web clips, and PDF capture. Your data stays as plain .md files on your device, and sync is zero-knowledge end-to-end encrypted, so neither Google nor anyone else can read your notes.'
      },
      {
        heading: 'Privacy by design, not by policy',
        body: 'Google Keep stores your notes in your Google account, accessible to Google and subject to legal requests. memrynote encrypts every note with XChaCha20-Poly1305 on your device before it reaches any server; keys are generated locally and never transmitted. The sync server holds only ciphertext, no Google account is required, and memrynote is open source so the encryption can be audited.'
      },
      {
        heading: 'A full workspace, not a wall of stickies',
        body: 'Google Keep is built for quick colour-coded notes, labels, and checklists — great for a grocery list, not a second brain. memrynote combines Markdown notes with wiki-links, full task management with projects and Kanban boards, a calendar that understands your due dates, a daily journal, and an inbox — all stored as local files in a folder you control.'
      },
      {
        heading: 'Migrating from Google Keep takes minutes',
        body: 'Switching is three steps: at takeout.google.com, request a Google Keep export; open memrynote → Settings → Import → Google Keep; point the importer at your downloaded archive. Your notes land as plain Markdown files in your vault with content intact, and your vault is portable — readable in any Markdown editor afterwards.'
      }
    ],
    pricing: {
      memry: 'Free, local-first forever. Encrypted sync from $5/mo.',
      competitor: 'Free (uses your Google account storage).'
    },
    whenCompetitorWins:
      'Google Keep is the better pick if you want frictionless mobile capture, instant sync across phones and the web, real-time sharing with others, or tight integration with Gmail and Google Calendar — all for free. memrynote’s advantages are privacy, ownership, and a real notes-tasks-calendar-journal workspace; it has no mobile app yet.',
    migration: {
      importer: 'Google Keep',
      steps: [
        'At takeout.google.com, request an export of Google Keep and download the archive.',
        'Open memrynote → Settings → Import and choose the Google Keep importer.',
        'Point it at your downloaded archive; notes land as plain Markdown files in your vault.'
      ]
    },
    faqs: [
      {
        question: 'Can I import my Google Keep notes into memrynote?',
        answer:
          'Yes. Export Google Keep via Google Takeout, then open memrynote → Settings → Import and choose the Google Keep importer. Your notes land as plain Markdown files in a folder you own.'
      },
      {
        question: 'Is Google Keep end-to-end encrypted?',
        answer:
          'No. Google Keep stores notes in your Google account, where Google can access them. memrynote encrypts every note on your device with XChaCha20-Poly1305, so the sync server only ever holds ciphertext.'
      },
      {
        question: 'Does memrynote do more than Google Keep?',
        answer:
          'Yes. Beyond notes, memrynote includes full task projects with Kanban and Calendar views, a daily journal, and a capture inbox — where Keep focuses on quick stickies, checklists, and reminders.'
      },
      {
        question: 'Does memrynote have a mobile app like Google Keep?',
        answer:
          'Not yet — memrynote is a desktop app for macOS, Windows, and Linux today. Because your vault is plain Markdown in a folder you own, the files stay readable on any device in the meantime.'
      }
    ],
    footnote: COMPARISON_FOOTNOTE
  }
]
