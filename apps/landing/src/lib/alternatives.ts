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
  }
]
