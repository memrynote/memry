import type { PAGE_META } from './seo'

export type AltCell = boolean | 'partial'

export type AltRow = {
  feature: string
  memry: AltCell
  competitor: AltCell
}

export type AlternativeConfig = {
  pageKey: keyof typeof PAGE_META
  competitor: string
  eyebrow: string
  heading: string
  headingAccent: string
  // Self-contained, declarative paragraph (~120-150 words) sized for AI-search citation.
  intro: string
  rows: readonly AltRow[]
  reasons: readonly { title: string; body: string }[]
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
    footnote: COMPARISON_FOOTNOTE
  }
]
