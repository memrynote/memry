import type { HeroTint } from './site-tints'

export interface BlogAuthor {
  name: string
  role: string
  url?: string
  avatar?: string
}

export interface BlogCallout {
  type: 'note' | 'tip' | 'warning'
  title?: string
  text: string
}

export interface BlogCodeBlock {
  language: string
  filename?: string
  code: string
}

export interface BlogComparisonTable {
  headers: [string, string, string]
  rows: Array<[string, string, string]>
}

export interface BlogFact {
  label: string
  value: string
}

export interface BlogSection {
  heading: string
  // Rendered as the section's id, so in-page links (#slug) can target it.
  slug?: string
  paragraphs: string[]
  facts?: readonly BlogFact[]
  bullets?: string[]
  callout?: BlogCallout
  code?: BlogCodeBlock
  table?: BlogComparisonTable
}

// One row of a "The short answer" table: a situation and the app to pick for it.
// `anchor` is the slug of the section that covers the pick.
export interface BlogShortAnswerRow {
  situation: string
  pick: string
  anchor: string
}

export interface BlogFaq {
  question: string
  answer: string
}

export interface BlogPost {
  slug: string
  pageKey: string
  title: string
  description: string
  summary: string
  datePublished: string
  dateModified: string
  author: BlogAuthor
  // Shown at the top of the post in place of the author's full name and role.
  byline?: string
  readingTime: string
  category: string
  heroTint: HeroTint
  tags: readonly string[]
  featured?: boolean
  lead: string
  shortAnswer?: readonly BlogShortAnswerRow[]
  sections: readonly BlogSection[]
  faqs?: readonly BlogFaq[]
  takeaways: readonly string[]
  relatedFeature: {
    label: string
    href: string
    description: string
  }
}

const DEFAULT_AUTHOR: BlogAuthor = {
  name: 'Kaan Karaca',
  role: 'Founder & Engineer at memrynote',
  url: 'https://x.com/h4yfans'
}

export const BLOG_POSTS: readonly BlogPost[] = [
  {
    slug: 'how-to-keep-a-plain-text-daily-journal-that-outlives-any-app',
    pageKey: 'blogJournalLongevity',
    title: 'How to keep a plain-text daily journal that outlives any app',
    description:
      'Why proprietary journaling apps eventually fail your memories, and how to structure a durable, file-based daily journal in plain Markdown with YAML frontmatter.',
    summary:
      'How to build a daily journaling ritual using plain text, portable Markdown, and open directory structures that survive cloud shutdowns, vendor acquisitions, and decades of tech shifts.',
    datePublished: '2026-08-31T08:00:00.000Z',
    dateModified: '2026-08-31T08:00:00.000Z',
    author: DEFAULT_AUTHOR,
    readingTime: '7 min read',
    category: 'Philosophy & Workflows',
    heroTint: 'sand',
    tags: ['Journaling', 'Markdown', 'Longevity', 'Local-First'],
    featured: true,
    lead: 'Digital journaling has a quiet longevity crisis. We pour our most intimate thoughts, struggles, and reflections into slick apps, only to watch them disappear when a startup gets acquired, changes pricing, or quietly sunsets its sync servers. Your memories should outlive the software used to write them.',
    sections: [
      {
        heading: 'The 30-year file test',
        paragraphs: [
          'Pick a random digital diary entry from ten years ago. Can you still open it without downloading an obsolete binary, resurrecting a legacy account, or parsing an obscure proprietary database format? For most people, the answer is a frustrating no.',
          'Proprietary journaling apps treat your reflections as user engagement metrics trapped inside SQLite blobs, JSON databases with custom binary wrappers, or cloud-only databases. When the company folds or pivots, you are left with an ugly export tool that spits out fragmented text without attachments or metadata.',
          'Plain text in standard UTF-8 Markdown is different. It is human-readable directly in a terminal, editable in any text editor ever built, indexable by standard filesystem utilities, and guaranteed to open in 2056 on whatever computer architecture exists.'
        ],
        callout: {
          type: 'note',
          title: 'The Lindy Effect of Plain Text',
          text: 'Plain text files (.txt and .md) have been universally readable for over 50 years. Any note system built on plain files inherits half a century of guaranteed backward compatibility.'
        }
      },
      {
        heading: 'Structuring daily entries with YAML frontmatter',
        paragraphs: [
          'A durable journal requires two things: raw narrative prose for your thoughts, and structured frontmatter for temporal context. Frontmatter allows computers to query, filter, and aggregate your entries without polluting the readability of your prose.',
          'By adopting standard YAML frontmatter at the head of every daily markdown file, you record vital context like dates, weather, mood, tags, and location. Here is the exact structure that balances human readability with machine searchability:'
        ],
        code: {
          language: 'markdown',
          filename: 'journal/2026-08-31.md',
          code: `---
title: Monday, August 31, 2026
date: 2026-08-31
tags: [reflection, deep-work, architecture]
weather: Sunny, 24°C
mood: focused
created_at: 2026-08-31T08:15:00Z
---

# Morning intentions
Clear the backlog of technical debt in the sync engine.
Focus on uninterrupted writing before noon.

## What happened today
Refactored the SQLite FTS5 tokenizer to support multi-language tokenization.
Had a great conversation with [[Team/Alex]] about CRDT conflict resolution.

## Evening reflections
Energy remained high throughout the afternoon. Taking walks between coding blocks makes a measurable difference.`
        }
      },
      {
        heading: 'Folder hierarchy: flat vs year-partitioned',
        paragraphs: [
          'A common pitfall is over-engineering folder hierarchies. Deep nested trees like `/journal/2026/08/week-35/monday.md` create unnecessary navigation friction. Every extra folder level adds keystrokes and mental overhead.',
          'We strongly recommend an ISO-8601 flat or year-partitioned convention: `YYYY-MM-DD.md` (e.g. `2026-08-31.md`). Files naturally sort chronologically in every file explorer, search indexing is instantaneous, and cross-linking via `[[2026-08-31]]` wiki-links is predictable.'
        ],
        bullets: [
          'Use ISO-8601 filenames (`YYYY-MM-DD.md`) for automatic chronological sorting.',
          'Keep one file per day to prevent merge conflicts and giant unmanageable files.',
          'Store embedded photos and voice memos in an adjacent `assets/` or `attachments/` folder using relative paths.',
          'Use bi-directional wiki-links like `[[Projects/Launch]]` to link journal entries to persistent project notes.'
        ]
      },
      {
        heading: 'Connecting daily context with tasks and calendar',
        paragraphs: [
          'A journal should not live in isolation from what you actually did. When you look back on a day five years from now, knowing which tasks you checked off and which meetings you attended provides indispensable context for why you felt stressed or energized.',
          'In modern local-first tools like memrynote, your daily journal sits side-by-side with your day’s calendar events and completed tasks in a single unified view, while persisting everything as clean Markdown on your local disk.'
        ]
      }
    ],
    takeaways: [
      'Store journal entries as individual Markdown (.md) files named by ISO-8601 date.',
      'Use YAML frontmatter for metadata (mood, weather, tags, timestamps) so entries remain queryable.',
      'Rely on relative filesystem paths for image and audio attachments rather than cloud URLs.',
      'Choose a local-first workspace that reads your disk directly instead of locking entries in a proprietary database.'
    ],
    relatedFeature: {
      label: 'Explore Memrynote Journal',
      href: '/features/journal',
      description:
        'A reflective daily writing ritual with day context sidebar, templates, and local Markdown storage.'
    }
  },
  {
    slug: 'what-end-to-end-encrypted-notes-actually-means',
    pageKey: 'blogE2EEncryption',
    title: 'What end-to-end encrypted notes actually means (and which apps really do it)',
    description:
      'Demystifying encryption claims in note apps. Learn the real technical difference between in-transit TLS, at-rest server encryption, and genuine zero-knowledge client-side encryption.',
    summary:
      'Most note-taking apps claim to be "securely encrypted," but their servers hold the master decryption keys. Here is how true zero-knowledge end-to-end encryption works with XChaCha20-Poly1305 and libsodium.',
    datePublished: '2026-08-31T08:00:00.000Z',
    dateModified: '2026-08-31T08:00:00.000Z',
    author: DEFAULT_AUTHOR,
    readingTime: '9 min read',
    category: 'Security & Cryptography',
    heroTint: 'mint',
    tags: ['Security', 'Cryptography', 'Privacy', 'E2EE'],
    featured: true,
    lead: 'Almost every cloud note app claims to be "encrypted and secure." Yet when you inspect the architecture, 95% of them hold the master keys on their own servers. That means employees, database breaches, AI scrapers, or government subpoenas can read every word of your personal knowledge base.',
    sections: [
      {
        heading: 'The three tiers of encryption in modern software',
        paragraphs: [
          'Marketing departments across the tech industry frequently use the word "encrypted" as a generic badge of security. But encryption is not binary: what matters is where the cryptographic keys reside and who has the technical authority to decrypt data.',
          'To evaluate whether a note-taking app genuinely protects your confidential notes, journal entries, and personal intellectual property, you need to understand the three distinct tiers of data encryption:',
          '1. In-Transit Encryption (TLS/HTTPS): Encrypts traffic between your browser or app and the cloud server. This prevents eavesdropping on open Wi-Fi networks at coffee shops or airports, but the cloud server decrypts the payload immediately upon receipt.',
          '2. At-Rest Encryption (Server-Side AES): Encrypts the raw blocks on the cloud provider’s storage volume (e.g. AWS EBS or Google Cloud persistent disk). While this protects against physical theft of hard drives from a server rack, the running application server holds the decryption key in memory and can read all user notes at any time.',
          '3. Zero-Knowledge Client-Side End-to-End Encryption (E2EE): Decryption keys are derived and stored strictly on your local hardware. Data is transformed into unreadable ciphertext before it leaves your machine. The sync server stores and routes encrypted blobs without ever holding the decryption key.'
        ],
        table: {
          headers: ['Encryption Type', 'Where Keys Live', 'Who Can Read Plaintext'],
          rows: [
            [
              'In-Transit (TLS/HTTPS)',
              'Client & Server',
              'The cloud provider, their employees, ISPs in transit'
            ],
            [
              'At-Rest (Server-side AES)',
              'Cloud Provider (AWS/GCP)',
              'The app vendor, database admins, subpoena recipients'
            ],
            [
              'Zero-Knowledge Client-Side E2EE',
              'Your Local Devices Only',
              'Only YOU and devices you explicitly pair'
            ]
          ]
        }
      },
      {
        heading: 'Why server-side encryption fails the privacy test',
        paragraphs: [
          'When an app like Notion, Google Keep, or Evernote states that user notes are "stored securely with AES-256 encryption," they are referring to server-side encryption. Because the server holds the decryption keys, vendor engineers and automated background workers have unrestricted access to your files.',
          'This server-side access enables cloud features like server-rendered search, AI indexing, and link previews, but it creates significant privacy vulnerabilities:',
          'First, any database breach, compromised admin credential, or misconfigured cloud bucket exposes your entire note history to attackers. Second, insider threat remains a constant reality: curious or malicious employees can inspect private vaults without leaving an audit trail on your device.',
          'Third, service providers are legally compelled to comply with government subpoenas, national security letters, and civil discovery requests. When an app uses server-side keys, they decrypt and hand over your personal journals, financial records, and medical notes without your consent.'
        ],
        callout: {
          type: 'warning',
          title: 'The Subpoena Test',
          text: 'If a cloud provider receives a court order for your data and can produce readable text, the app is NOT end-to-end encrypted. True zero-knowledge architecture makes compliance mathematically impossible because the server holds only opaque ciphertext.'
        }
      },
      {
        heading: 'How genuine zero-knowledge E2EE works under the hood',
        paragraphs: [
          'In a genuine zero-knowledge architecture like memrynote, cryptographic operations occur strictly on your physical machine before any byte touches the network wire. The sync server acts as a blind relay for encrypted binary chunks.',
          'Here is the step-by-step cryptographic pipeline that ensures mathematical confidentiality:',
          '1. Key Derivation: When you create a vault, your device derives a 256-bit master key using Argon2id with memory-hard parameters, making brute-force dictionary attacks computationally infeasible.',
          '2. Symmetric Payload Encryption: Every note, journal entry, and task payload is encrypted locally using libsodium’s authenticated XChaCha20-Poly1305 cipher with random 192-bit nonces, ensuring both privacy and tamper-proofing.',
          '3. Device Identity & Signing: Each authorized device generates an Ed25519 asymmetric keypair. Sync requests and CRDT vector updates are cryptographically signed by the device private key to prevent replay attacks.',
          '4. Storage Separation: Encrypted payload blobs reside in Cloudflare R2 object storage, while opaque item IDs and version vectors reside in D1. The server coordinates sync routing but possesses zero capability to decrypt note text, filenames, or tag properties.'
        ],
        code: {
          language: 'typescript',
          filename: 'sync-crypto-pipeline.ts',
          code: `// High-level conceptual flow of zero-knowledge client sync
import sodium from 'libsodium-wrappers-sumo'

export function encryptVaultPayload(plaintext: Uint8Array, vaultKey: Uint8Array): EncryptedPayload {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null, // additional authenticated data
    null, // secret nonce
    nonce,
    vaultKey
  )
  return { nonce, ciphertext }
}`
        }
      },
      {
        heading: 'Comparing encryption across major note apps',
        paragraphs: [
          'Understanding which note applications implement genuine zero-knowledge encryption helps you make informed choices about where to store sensitive ideas:',
          'Notion uses standard TLS in transit and AWS AES-256 at rest. Notion servers have full access to your workspace plaintext to run search indexes and train AI workspace features.',
          'Evernote allows users to highlight specific snippets of text and encrypt them with a custom passphrase. However, note titles, tags, notebooks, and unselected text remain completely unencrypted on Evernote servers.',
          'Apple Notes offers standard iCloud encryption where Apple manages keys. When Advanced Data Protection (ADP) is enabled in iCloud settings, notes are end-to-end encrypted, though access is restricted to Apple ecosystem devices.',
          'Obsidian Sync offers genuine zero-knowledge end-to-end encryption with a user-defined passphrase as a paid add-on ($4 to $5 monthly), while the base app operates entirely locally.',
          'memrynote is built local-first by default with zero cloud requirement. When optional hosted sync is enabled, every note, task, journal entry, and attachment is protected with zero-knowledge XChaCha20-Poly1305 encryption across macOS, Windows, and Linux.'
        ],
        bullets: [
          'Notion: Standard TLS in transit, AES at rest. No client-side encryption. Vendor has full plaintext access.',
          'Evernote: Individual text snippets can be manually encrypted with a passphrase, but note titles, tags, and notebooks are unencrypted on servers.',
          'Apple Notes: Standard iCloud notes are server-encrypted. If you turn on Advanced Data Protection (ADP), end-to-end encryption is enabled across Apple devices, though Windows/Linux platforms remain unsupported.',
          'Obsidian Sync: Offers end-to-end encryption with a user-supplied passphrase as a paid add-on ($4–$5/mo).',
          'memrynote: Local-first by default with zero cloud requirement. Hosted sync is 100% zero-knowledge E2EE via XChaCha20-Poly1305 across macOS, Windows, and Linux.'
        ]
      }
    ],
    takeaways: [
      '"Encrypted at rest" protects against stolen physical hard drives, not against software breaches or vendor access.',
      'True E2EE requires client-side encryption where keys never leave your physical hardware.',
      'Modern cryptographic standards like XChaCha20-Poly1305 and Argon2id provide battle-tested security without performance penalties.',
      'Always check whether an app can perform server-side keyword search; if the server can search your text, it can read your text.'
    ],
    relatedFeature: {
      label: 'Read the Security Architecture',
      href: '/security',
      description:
        'Explore the full cryptographic blueprint of memrynote’s zero-knowledge sync layer.'
    }
  },
  {
    slug: 'local-first-vs-cloud-first-note-taking-apps',
    pageKey: 'blogLocalFirstOffline',
    title: 'Local-first vs cloud-first note apps: what breaks when you go offline',
    description:
      'Why cloud-first note taking apps stutter on slow connections, drop offline edits, and create sync conflicts, and how local-first architecture fixes productivity software.',
    summary:
      'A deep architectural comparison between cloud-first web apps and local-first software. Learn why reading and writing to local disk with CRDTs beats client-server round trips every time.',
    datePublished: '2026-08-31T08:00:00.000Z',
    dateModified: '2026-08-31T08:00:00.000Z',
    author: DEFAULT_AUTHOR,
    readingTime: '8 min read',
    category: 'Architecture & Engineering',
    heroTint: 'sky',
    tags: ['Local-First', 'CRDT', 'Offline', 'Architecture'],
    featured: false,
    lead: 'We have all experienced it: you open your note app on a train or in an airplane, try to capture an urgent idea, and watch a loading spinner freeze your cursor. Or worse, you edit a document offline only to have the server overwrite your paragraphs with a merge conflict when you reconnect.',
    sections: [
      {
        heading: 'The Seven Principles of Local-First Software',
        paragraphs: [
          'In 2019, Martin Kleppmann and his colleagues at Ink & Switch published a seminal research paper titled "Local-first software: you own your data, in spite of the cloud." They articulated seven core ideals that redefine how human software should work in a world dominated by fragile cloud services:',
          '1. No spinners: your work at your fingertips instantly without waiting for remote server round-trips.',
          '2. Your work is not trapped on one device: multi-device synchronization is continuous and backgrounded.',
          '3. The network is optional: every feature functions identically whether you are on fiber broadband, spotty cellular data, or completely disconnected in airplane mode.',
          '4. Seamless collaboration with peers: multiple devices can write to the same documents simultaneously without locking files.',
          '5. The long now: software and data structures that continue working for decades without relying on vendor server maintenance.',
          '6. Security and privacy by default: client-side encryption protects your intellectual property from remote cloud breaches.',
          '7. You retain ultimate ownership and control: files exist in open, inspectable formats on your local storage device.'
        ]
      },
      {
        heading: 'What breaks in cloud-first architectures',
        paragraphs: [
          'Cloud-first applications (such as Notion, Coda, or Roam Research) are architected around a centralized client-server paradigm. The canonical copy of your workspace lives inside a remote cloud database (typically PostgreSQL or DynamoDB), while the desktop app is essentially an embedded browser window displaying a transient, cached view.',
          'When network conditions degrade or connectivity drops, cloud-first architectures break down in three critical ways:',
          'Latency Tax: Every keystroke, page navigation, or database query must validate against a remote API endpoint. Even on high-speed Wi-Fi, 100ms round trips create subtle micro-stutters that interrupt cognitive flow compared to memory-mapped local reads.',
          'Fragile Offline Modes: Offline support in cloud-first apps is an afterthought bolted on via Service Workers or browser IndexedDB caches. If you close the window or experience an app crash before pending changes reach the cloud, offline edits can vanish permanently.',
          'Destructive Conflicts: When two paired devices make simultaneous edits, cloud systems typically resolve conflicts using crude "Last-Write-Wins" timestamps at the document level. This silently wipes out entire paragraphs written on the second device without warning.'
        ],
        bullets: [
          'Latency Tax: Every keystroke, page navigation, or database query must validate against a remote API. Even on fast Wi-Fi, 100ms round trips feel sluggish compared to local memory.',
          'Fragile Offline Modes: Offline support in cloud-first apps is an afterthought bolted on via Service Workers or IndexedDB caches. If you close the app before syncing, pending edits can be lost forever.',
          'Destructive Conflicts: When two devices edit simultaneously, cloud apps use "Last-Write-Wins" timestamps at the document level, silently wiping out whole paragraphs written on the second device.'
        ]
      },
      {
        heading: 'How local-first solves conflict-free sync with CRDTs',
        paragraphs: [
          'Local-first software completely flips the architectural hierarchy: your local filesystem and SQLite database are the definitive, authoritative source of truth. Writes are instantaneous (0ms perceived latency) because they commit immediately to local disk. The network functions purely as a secondary, background transport mechanism.',
          'To merge edits across devices without data loss or modal merge conflict dialogs, local-first applications utilize Conflict-free Replicated Data Types (CRDTs) like Yjs. CRDTs represent document edits as mathematical operations that can be applied in any chronological order across multiple machines, converging deterministically to the identical document state.',
          'Whether you take notes on your laptop during an offline flight or edit tasks on your desktop at home, the sync engine reconciles every character change automatically the second both devices re-establish connectivity.'
        ],
        code: {
          language: 'text',
          filename: 'crdt-vs-lww.txt',
          code: `Cloud-First (Last-Write-Wins):
Device A edits paragraph 1 at 10:00:01
Device B edits paragraph 2 at 10:00:02
Result: Server overwrites Device A's paragraph entirely.

Local-First (Yjs CRDT):
Device A inserts char block [A1..A15] at offset 0
Device B inserts char block [B1..B20] at offset 42
Result: Both operations merge deterministically. Zero data lost.`
        }
      },
      {
        heading: 'Instant search: SQLite FTS5 vs Cloud API search',
        paragraphs: [
          'When your personal knowledge base is stored locally in an embedded SQLite database, full-text search across 50,000 notes executes in 4 to 8 milliseconds using SQLite’s native FTS5 engine and BM25 ranking.',
          'You get instant, interactive search results as you type every single letter, with zero network latency, zero bandwidth consumption, and complete resilience against server outages or API rate limits.'
        ]
      }
    ],
    takeaways: [
      'Cloud-first apps make your productivity hostage to server uptime and network quality.',
      'Local-first apps execute all reads and writes against local disk for zero-latency interaction.',
      'CRDTs enable automatic, mathematical conflict resolution across offline devices without data loss.',
      'You own your files locally in open formats, meaning you can never be locked out of your workspace.'
    ],
    relatedFeature: {
      label: 'Compare Local-First Features',
      href: '/compare',
      description: 'See how Memrynote compares to cloud-first tools like Notion and Capacities.'
    }
  },
  {
    slug: 'running-a-pkm-from-the-terminal',
    pageKey: 'blogTerminalPkm',
    title: 'Running a PKM from the terminal: scriptable notes, tasks, and journal',
    description:
      'Run your personal knowledge base from a CLI: query notes, capture tasks from git hooks, append to your daily journal, and script workflows with Unix pipes.',
    summary:
      'Why terminal-native note-taking is the ultimate developer workflow. How to use headless CLI tooling to query, create, and automate your vault with shell pipelines and AI agents.',
    datePublished: '2026-08-31T08:00:00.000Z',
    dateModified: '2026-08-31T08:00:00.000Z',
    author: DEFAULT_AUTHOR,
    readingTime: '6 min read',
    category: 'Developer Workflows',
    heroTint: 'ink',
    tags: ['CLI', 'Terminal', 'Automation', 'Developer'],
    featured: false,
    lead: 'For developers and engineers, context switching between a coding terminal and a heavy GUI note app kills momentum. If you can query your database, trigger deployments, and commit code from the command line, why should your notes, tasks, and daily reflections be trapped behind mouse clicks?',
    sections: [
      {
        heading: 'The Unix Philosophy applied to Personal Knowledge Management',
        paragraphs: [
          'The Unix philosophy emphasizes building small programs that do one specific job exceptionally well and communicate via universal text streams. When your PKM exposes a first-class Command Line Interface (CLI), your second brain transforms into a composable Unix utility.',
          'Rather than treating your knowledge repository as an isolated silo accessible only through a graphical window, a CLI unlocks automated scripting: piping git commit logs into your daily journal, capturing action items automatically from code review comments, and feeding search results into fzf, jq, or tmux sessions for custom developer dashboards.',
          'Because the underlying data is stored as plain Markdown and local SQLite tables, terminal queries execute in single-digit milliseconds with zero API latency.',
          'This composability bridges the historical gap between software development and personal note-taking. When you can pipe compiler outputs, curl responses, or stack traces directly into your scratch inbox, your documentation workflow naturally integrates with your engineering environment.'
        ]
      },
      {
        heading: 'Core terminal workflows with the memry CLI',
        paragraphs: [
          'The `memry` CLI ships directly with memrynote desktop, allowing headless interaction with your local vault without needing the full Electron application running in the foreground.',
          'Under the hood, the CLI communicates directly with your local vault database and filesystem. It does not depend on an internet connection or a running background daemon, ensuring that shell scripts execute instantaneously.',
          'Here are five high-leverage terminal commands used by engineers for daily development, task tracking, and structured reflection:'
        ],
        code: {
          language: 'bash',
          filename: 'terminal-pkm-examples.sh',
          code: `# 1. Quick-capture an idea into your Inbox without leaving your terminal
memry inbox add "Investigate memory leak in SQLite connection pool"

# 2. Append a deploy log directly to today's daily journal
echo "Shipped v1.4.2 to staging at $(date)" | memry journal append

# 3. Create a task with priority, project tag, and deadline
memry task add "Review PR #412" --project "Backend" --due tomorrow --priority high

# 4. Search across your entire Markdown vault with structured JSON output
memry search "XChaCha20" --json | jq '.[].title'

# 5. List today's agenda and overdue tasks
memry agenda --today`
        }
      },
      {
        heading: 'Automating developer rituals with Git hooks and shell aliases',
        paragraphs: [
          'By integrating the CLI into your shell startup configuration (`.zshrc` or `.bashrc`) and git hooks, you can automate repetitive engineering rituals.',
          'For example, a `post-commit` hook can automatically append commit summaries to your daily developer log, or a custom shell function `standup` can extract yesterday’s checked-off tasks and today’s calendar events formatted as markdown for your team standup meeting.',
          'Furthermore, modern AI development agents can interface directly with your vault using the Model Context Protocol (MCP), allowing coding assistants to query documentation notes and write task items with explicit user approval.'
        ],
        bullets: [
          'Add `alias inbox="memry inbox add"` for instant thought capture anywhere in bash/zsh.',
          'Use git post-commit hooks to append commit messages to your daily developer log.',
          'Integrate with tmux and fzf for keyboard-driven fuzzy vault browsing in under 10ms.',
          'Connect with local AI models and MCP (Model Context Protocol) agents for automated task triage.'
        ]
      }
    ],
    takeaways: [
      'A terminal CLI turns your personal knowledge base into a programmable development tool.',
      'Headless JSON output allows clean piping into jq, grep, fzf, and automation scripts.',
      'Zero context-switching: capture ideas and log work without leaving your code editor.',
      'Local-first storage guarantees CLI operations complete in milliseconds directly against disk.'
    ],
    relatedFeature: {
      label: 'Explore the memry CLI',
      href: '/cli',
      description: 'Learn how to script your notes, tasks, journal, and calendar from the terminal.'
    }
  },
  {
    slug: 'migrating-from-evernote-notion-to-markdown',
    pageKey: 'blogMarkdownMigration',
    title: 'Migrating from Evernote or Notion to Markdown without losing structure',
    description:
      'A practical, step-by-step guide to exporting your knowledge base from Evernote or Notion into clean, portable Markdown with frontmatter, wiki-links, and attachments intact.',
    summary:
      'Escape proprietary note silos without losing your nested folders, page databases, tags, or image attachments. Step-by-step migration guide to open standard Markdown.',
    datePublished: '2026-08-31T08:00:00.000Z',
    dateModified: '2026-08-31T08:00:00.000Z',
    author: DEFAULT_AUTHOR,
    readingTime: '8 min read',
    category: 'Guides & Migration',
    heroTint: 'rose',
    tags: ['Migration', 'Notion', 'Evernote', 'Markdown', 'Import'],
    featured: false,
    lead: 'Deciding to leave a proprietary note app is easy; the scary part is migrating ten thousand notes accumulated over five years. Many users stay trapped in legacy software because they fear losing page hierarchies, formatted tables, frontmatter properties, and embedded images.',
    sections: [
      {
        heading: 'Why export formats matter: The ENEX and HTML trap',
        paragraphs: [
          'Proprietary note tools intentionally make data export cumbersome to discourage churn. Evernote exports notebooks to `.enex` files — an archaic XML format containing escaped HTML entities, custom XML tags (`<en-note>`), and binary attachments encoded as giant base64 blocks.',
          'Notion’s export produces zip archives with random 32-character hexadecimal UUID hashes appended to every single file and folder name (for example, `Project Roadmap 8f4a1c2b91d442eaa813c91834e9d012.md`). These hash suffixes break internal page cross-links, rendering wiki-links useless in standard Markdown editors.',
          'A successful, loss-free migration must systematically clean up these artifacts, standardize metadata into standard YAML frontmatter, preserve folder structures, and convert internal URL references into standard `[[Wiki links]]`.'
        ]
      },
      {
        heading: 'Migrating from Notion to clean Markdown',
        paragraphs: [
          'To migrate a multi-year Notion workspace to an open, local Markdown vault, follow this structured four-step methodology:',
          '1. Export Workspace Package: In Notion, navigate to Settings & Members → Settings → Export all workspace content. Select "Markdown & CSV" and ensure the "Include subpages" toggle is enabled.',
          '2. Unzip and Inspect: Extract the archive onto your local drive. Observe how Notion creates nested directories matching your page tree, but litters filenames with hexadecimal UUID hashes.',
          '3. Automated Hash Stripping & Link Rewriting: Using an automated tool like memrynote’s built-in Notion importer, the system scans the directory tree, strips the 32-character UUID suffixes from file and directory names, translates Notion database properties into clean YAML frontmatter arrays, and rewrites Notion page links into standard `[[Page Name]]` wiki-links.',
          '4. Attachment Verification: Verify that embedded screenshots, diagrams, and PDF attachments are extracted to relative `./attachments/` paths, ensuring notes render correctly offline in any Markdown editor.'
        ],
        bullets: [
          'Step 1: In Notion, go to Settings & Members → Settings → Export content → Select "Markdown & CSV" with "Include subpages" enabled.',
          'Step 2: Unzip the export package. Notice that Notion generates hash suffixes on file and folder names.',
          'Step 3: Use an automated importer (like memrynote’s built-in Notion importer) that automatically strips UUID hashes, converts Notion relation properties to YAML frontmatter, and rewrites Notion page links into `[[Note Name]]` wiki-links.',
          'Step 4: Verify image and PDF attachments: ensure relative links like `./attachments/diagram.png` point to the local media directory.'
        ]
      },
      {
        heading: 'Migrating from Evernote (.enex)',
        paragraphs: [
          'Evernote migrations involve exporting notebooks as `.enex` archives. The primary technical challenge is converting Evernote’s custom `<en-note>` XML and inline HTML markup into clean, portable CommonMark markdown.',
          'Memrynote includes a specialized native .enex parser that automatically converts Evernote tags into YAML frontmatter arrays, transforms complex web clips and tables into standard Markdown syntax, extracts embedded binary attachments into an adjacent assets folder, and preserves the original creation and modification timestamps recorded in the ENEX metadata.'
        ],
        code: {
          language: 'yaml',
          filename: 'converted-note-frontmatter.yaml',
          code: `# Clean result after importing from Evernote/Notion into Memrynote
---
title: Project Architecture Overview
created_at: 2024-03-15T14:20:00Z
updated_at: 2026-08-31T09:00:00Z
tags: [architecture, backend, crypto]
source_app: notion
original_id: 8f4a1c2b-91d4-42ea-a813-c91834e9d012
---

# Project Architecture Overview

Referenced in [[Q3 Roadmap]] and [[Security Whitepaper]].`
        }
      },
      {
        heading: 'Verifying your new vault',
        paragraphs: [
          'Once your notes have been imported into a clean local Markdown folder, perform three quick verification checks to ensure complete data integrity:',
          '1. Full-Text Search Coverage: Search for an obscure phrase from a historical note to confirm that indexing has indexed all imported content.',
          '2. Backlink Resolution: Click on internal `[[wiki-links]]` to verify that every link resolves to its target note without missing-target warnings.',
          '3. Raw Text Portability: Open the folder in VS Code, Obsidian, or inspect files with standard terminal tools like `cat` to confirm that every note is standard, readable plain text without proprietary locks.'
        ]
      }
    ],
    takeaways: [
      'Never let fear of migration keep you trapped in a slow, expensive, or unencrypted tool.',
      'Clean Markdown with YAML frontmatter is the most future-proof format for personal knowledge.',
      'Native importers handle the heavy lifting of stripping UUID hashes and converting proprietary XML into clean CommonMark.',
      'Once in standard Markdown, your knowledge base is permanently free from vendor lock-in.'
    ],
    relatedFeature: {
      label: 'Explore Note Features & Importers',
      href: '/features/notes',
      description:
        'Discover Memrynote’s markdown notes, backlinks, properties, and built-in importers.'
    }
  },
  {
    slug: 'best-end-to-end-encrypted-notes-apps',
    pageKey: 'blogBestE2EENotes',
    title: 'The best end-to-end encrypted notes apps in 2026',
    description:
      'Joplin, Anytype, Notesnook, Standard Notes, Obsidian, Proton Docs, and MemryNote compared: what the server can see, offline use, price, and where each falls short.',
    summary:
      'Seven end-to-end encrypted notes apps, each checked the same way: how it encrypts, what the server can still see, whether it works offline, what it costs, and where it falls short.',
    datePublished: '2026-10-13T08:00:00.000Z',
    dateModified: '2026-10-30T08:00:00.000Z',
    author: DEFAULT_AUTHOR,
    byline: 'Kaan, founder of MemryNote',
    readingTime: '12 min read',
    category: 'Security & Cryptography',
    heroTint: 'mint',
    tags: ['E2EE', 'Privacy', 'Comparison', 'Local-First'],
    featured: false,
    lead: 'An end-to-end encrypted notes app encrypts your notes on your own devices, so the company running the sync server cannot read them. The seven apps below all do that, and they differ in where your notes live, whether they work offline, and what they cost. We make MemryNote, one of the apps on this list. Every entry has the same parts, including where the app falls short, ours too, and the last section explains how we made the list.',
    shortAnswer: [
      {
        situation:
          'Want free, open-source notes you can sync through Dropbox, OneDrive, Nextcloud, or your own server',
        pick: 'Joplin',
        anchor: 'joplin'
      },
      {
        situation:
          'Think in objects and relations and want local-first sync with no readable copy on any server',
        pick: 'Anytype',
        anchor: 'anytype'
      },
      {
        situation:
          'Want a free encrypted notes app on every platform, including Android and the web',
        pick: 'Notesnook',
        anchor: 'notesnook'
      },
      {
        situation:
          'Want a focused encrypted notes app with a long track record, now part of Proton',
        pick: 'Standard Notes',
        anchor: 'standard-notes'
      },
      {
        situation: 'Want plain Markdown files on your disk and enjoy building your own setup',
        pick: 'Obsidian with an encrypted sync plugin',
        anchor: 'obsidian'
      },
      {
        situation: 'Already pay for Proton and want documents in the same encrypted account',
        pick: 'Proton Docs',
        anchor: 'proton'
      },
      {
        situation:
          'Want notes, tasks, journal and calendar in one calm app, end-to-end encrypted and offline-first',
        pick: 'MemryNote',
        anchor: 'memrynote'
      }
    ],
    sections: [
      {
        heading: 'We make MemryNote. Here is where it falls short.',
        slug: 'where-memrynote-falls-short',
        paragraphs: [
          'MemryNote is our app, so read this list knowing that. It is on the list because it is what we recommend to people who want their notes, tasks, journal, and calendar in one encrypted place. It is not the right pick for everyone. These are its gaps today:'
        ],
        bullets: [
          'It is a desktop app first. MemryNote runs on macOS, Windows, and Linux. The iPhone app is in TestFlight beta, and there is no Android app, iPad layout, or web app yet.',
          'It is in beta. The app is young and built by one founder, so expect rough edges and frequent releases.',
          'AI features are early. Agent Chat is available in the desktop app, while AI search and suggestions are still listed as coming soon.',
          'There is no sharing or collaboration. A vault syncs across your own devices only. Shared vaults and publishing are on the roadmap.',
          'You cannot choose your own sync backend. Sync runs through our hosted, end-to-end encrypted service. A self-hosted sync server is planned, not available. Joplin and Obsidian cover Dropbox, WebDAV, or your own server today.',
          'Sync is paid. The local app is free, and syncing between devices starts at $5 a month.',
          'If you lose your recovery phrase, we cannot restore your synced data, because we never hold your keys. The Markdown files on your disk stay readable.'
        ]
      },
      {
        heading: 'What to check in an encrypted notes app',
        slug: 'what-to-check',
        paragraphs: [
          '"Encrypted" is a broad word. Most note apps encrypt traffic and disks and still hold the keys, so they can read your notes. End-to-end encryption is narrower: notes are encrypted on your device with keys the company never has. Every app on this list does that, at least as an option. Four questions separate them.',
          'What can the server still see? No sync service is blind. It needs your account email, and it usually sees how many items you have, how large they are, and when they changed. A good app also encrypts titles, tags, and folder names, not only note bodies.',
          'Where do your notes live? Some apps keep notes in their own encrypted database, which only that app can open. Others keep plain files on your disk that any editor can read.',
          'Does it work offline? You should be able to open, edit, and search everything with no connection, and sync should catch up later.',
          'Can you leave? Check for a full export to an open format, such as Markdown, before you put years of writing into an app.'
        ],
        callout: {
          type: 'tip',
          title: 'A quick test',
          text: 'Ask support whether they can recover your notes if you forget your password. If they can, the service holds a key that can read them.'
        }
      },
      {
        heading: 'Joplin',
        slug: 'joplin',
        paragraphs: [
          'Joplin is a free, open-source notes app with Markdown notes, notebooks, tags, to-dos, and a web clipper. It runs on Windows, macOS, Linux, iOS, Android, and in a terminal.',
          'Its sync is the most flexible on this list: Joplin Cloud, Dropbox, OneDrive, Nextcloud, WebDAV, S3, or a local folder. End-to-end encryption works with all of them, but it is off by default. You turn it on in the encryption settings and set a master password, which Joplin cannot recover.'
        ],
        facts: [
          {
            label: 'Encryption',
            value:
              'Optional end-to-end encryption for notes, notebooks, tags, and attachments, with a master password. Off until you enable it.'
          },
          {
            label: 'What the server sees',
            value:
              'With encryption on, the sync target holds encrypted items and can see how many there are, their sizes, and when they change. With encryption off, it holds readable notes.'
          },
          {
            label: 'Local-first',
            value:
              'Yes. Notes live in a local database and the app works fully offline. Markdown files come from export, not from the working copy.'
          },
          {
            label: 'Price',
            value: 'Free. Joplin Cloud starts at €2.99 a month, or €2.40 a month billed yearly.'
          },
          {
            label: 'Best for',
            value:
              'People who want a free, open-source app and want to choose where their encrypted notes sync.'
          },
          {
            label: 'Where it falls short',
            value:
              'You must remember to turn encryption on, on your first device, before you rely on sync. The interface feels dated next to newer apps, and there is no calendar or task manager beyond to-do notes.'
          }
        ]
      },
      {
        heading: 'Anytype',
        slug: 'anytype',
        paragraphs: [
          'Anytype is a local-first workspace built on objects, types, and relations, with a block editor and sets that work like simple databases. It runs on macOS, Windows, Linux, iOS, and Android.',
          'Your keys are generated on your device and never sent to Anytype. Changes sync through the Anytype network, and you can run your own network instead if you want sync data off their servers.'
        ],
        facts: [
          {
            label: 'Encryption',
            value:
              'End-to-end by default. Objects are encrypted on your device with keys only you hold.'
          },
          {
            label: 'What the server sees',
            value:
              'Encrypted objects and the metadata needed to route them. Anytype also collects anonymized product usage data, kept separate from your content.'
          },
          {
            label: 'Local-first',
            value:
              "Yes. Everything works offline, stored on your device in Anytype's own encrypted object format."
          },
          {
            label: 'Price',
            value:
              'Free with 100 MB of remote storage. Plus ($4 a month), Pro ($8), and Ultra ($16) add storage.'
          },
          {
            label: 'Best for',
            value:
              'People who like building structured systems from objects and relations, and want no readable copy on any server.'
          },
          {
            label: 'Where it falls short',
            value:
              'Your notes are not plain files. Only Anytype reads the working format, and Markdown is an export. The object model takes time to learn, and the code is source-available rather than open source.'
          }
        ]
      },
      {
        heading: 'Notesnook',
        slug: 'notesnook',
        paragraphs: [
          'Notesnook is an open-source notes app that encrypts everything by default. It runs on Windows, macOS, Linux, iOS, Android, and the web, with notebooks, tags, reminders, and a rich-text editor.',
          'Its free plan is generous: unlimited notes on unlimited devices, end-to-end encrypted, with 50 MB of attachment uploads a month. Paid plans add attachment storage and larger files.'
        ],
        facts: [
          {
            label: 'Encryption',
            value:
              'End-to-end by default for every note, with XChaCha20-Poly1305 and keys derived from your password.'
          },
          {
            label: 'What the server sees',
            value:
              'Encrypted notes, your account email, and sync metadata such as item sizes and change times.'
          },
          {
            label: 'Local-first',
            value:
              'Partly. Each app keeps a local copy you can read and edit offline, but the app is built around a Notesnook account and its sync.'
          },
          {
            label: 'Price',
            value:
              'Free. Essential is $19.99 a year, Pro $69.99 a year, and Believer $89.99 a year.'
          },
          {
            label: 'Best for',
            value:
              'People who want encrypted notes on every device, including Android and a browser, without paying.'
          },
          {
            label: 'Where it falls short',
            value:
              "Notes live in the app's own database, so you get files only through export. There is no task manager, calendar, or journal beyond notes and reminders."
          }
        ]
      },
      {
        heading: 'Standard Notes',
        slug: 'standard-notes',
        paragraphs: [
          'Standard Notes launched in 2017 and has focused on encrypted notes ever since. In 2024 it joined Proton, the company behind Proton Mail. It runs on the web, desktop, iOS, and Android.',
          'The free plan syncs notes across unlimited devices. Paid plans add the Super note type for Markdown and rich text, folders, Daily Notebooks for journaling, longer revision history, and, on Professional, 100 GB of encrypted file storage.'
        ],
        facts: [
          {
            label: 'Encryption',
            value:
              'End-to-end by default. Notes and tags are encrypted on your device with XChaCha20-Poly1305.'
          },
          {
            label: 'What the server sees',
            value:
              'Encrypted items, your account email, and sync metadata such as item types and change times.'
          },
          {
            label: 'Local-first',
            value:
              'Partly. The apps keep an encrypted local copy and work offline, and sync needs a Standard Notes account.'
          },
          {
            label: 'Price',
            value:
              'Free Standard plan. Productivity and Professional are paid plans; check the Standard Notes plans page for current prices.'
          },
          {
            label: 'Best for',
            value:
              "People who want a simple, long-running encrypted notes app and value Proton's backing."
          },
          {
            label: 'Where it falls short',
            value:
              "The better editors and journaling are on paid plans. Notes live in the app's storage, and plain files come from export. There is no task manager or calendar."
          }
        ]
      },
      {
        heading: 'Obsidian, with an encrypted sync plugin',
        slug: 'obsidian',
        paragraphs: [
          'Obsidian stores notes as plain Markdown files in a folder on your disk. The app is free, runs on macOS, Windows, Linux, iOS, and Android, and has thousands of community plugins. On its own it does not sync, so the encryption question is about how you sync.',
          'Obsidian Sync, the official add-on, encrypts your remote vault end to end by default with a password only you know. The community plugin Self-hosted LiveSync is the main alternative: it supports end-to-end encryption and syncs through a CouchDB server or object storage that you run.'
        ],
        facts: [
          {
            label: 'Encryption',
            value:
              "End-to-end with Obsidian Sync (AES-256, the default for new remote vaults) or with Self-hosted LiveSync's encryption option. The vault on your disk is not encrypted."
          },
          {
            label: 'What the server sees',
            value:
              'With end-to-end encrypted Obsidian Sync, encrypted files and sync metadata. If you pick standard encryption instead, Obsidian holds the key. With LiveSync, the server is yours.'
          },
          {
            label: 'Local-first',
            value: 'Yes. Notes are plain Markdown files and everything works offline.'
          },
          {
            label: 'Price',
            value:
              'Free app. Obsidian Sync is $4 a month (Standard) or $8 a month (Plus), billed yearly. Self-hosted LiveSync is free, plus the cost of your server.'
          },
          {
            label: 'Best for',
            value:
              'People who want plain files they fully control and enjoy assembling their own setup.'
          },
          {
            label: 'Where it falls short',
            value:
              'Privacy depends on choices you make: choose standard encryption or misconfigure a plugin, and your notes are readable on the server. Community plugins run with full access to your vault. Tasks, calendars, and journals come from plugins you maintain, and the app is not open source.'
          }
        ]
      },
      {
        heading: 'Proton Docs and other encrypted cloud suites',
        slug: 'proton',
        paragraphs: [
          'Some people do not want a separate notes app. They want their writing in the encrypted account they already use for email. Proton Docs is the clearest example: an end-to-end encrypted, collaborative document editor inside Proton Drive, next to Proton Mail, Calendar, and Pass.',
          "This is a cloud-first model. Documents live in Proton Drive and you edit them through Proton's apps, much like Google Docs, but encrypted. It suits long documents and shared work better than quick, linked, everyday notes. If you want a notes app from Proton specifically, that is Standard Notes."
        ],
        facts: [
          {
            label: 'Encryption',
            value: 'End-to-end by default for documents and file names in Proton Drive.'
          },
          {
            label: 'What the server sees',
            value:
              'Encrypted documents, your account details, and file metadata such as sizes and modification times.'
          },
          {
            label: 'Local-first',
            value: "No. Documents live in Proton Drive and open through Proton's apps."
          },
          {
            label: 'Price',
            value:
              'Free with 5 GB of Proton Drive storage. Drive Plus is $3.99 a month billed yearly, or $4.99 monthly, and Proton bundles cover the whole suite.'
          },
          {
            label: 'Best for',
            value:
              'People who already use Proton and want encrypted documents they can share and edit together.'
          },
          {
            label: 'Where it falls short',
            value:
              "It is a document editor, not a notes system, so there are no backlinks, tags, or daily notes. Your documents are not files on your disk, and you depend on Proton's apps to open them."
          }
        ]
      },
      {
        heading: 'MemryNote',
        slug: 'memrynote',
        paragraphs: [
          'MemryNote is our app: one local-first workspace for notes, tasks, a daily journal, a calendar, and a capture inbox. Your vault is a folder you choose. Notes and journal entries are plain Markdown files with YAML frontmatter, so any editor can open them, with or without MemryNote installed.',
          'When you turn on sync, every note, task, journal entry, and attachment is encrypted on your device with XChaCha20-Poly1305 before upload. Keys are derived on your machine with Argon2id, and each device signs its changes with its own Ed25519 key, so the server cannot forge or quietly alter what it stores. The code is open source under AGPL-3.0.',
          'It works fully offline with no account. It imports Markdown folders, including Obsidian vaults, plus Notion, Evernote, Apple Notes, Bear, Google Keep, Todoist, and more.'
        ],
        facts: [
          {
            label: 'Encryption',
            value:
              'End-to-end, always on for sync: XChaCha20-Poly1305 for content, Argon2id for key derivation, and an Ed25519 signature on every synced item.'
          },
          {
            label: 'What the server sees',
            value:
              'Your account email, your devices, and for each item an ID, its type, its size, and when it changed. Titles, bodies, properties, task fields, and attachments are ciphertext.'
          },
          {
            label: 'Local-first',
            value:
              'Yes. Markdown files plus a local SQLite index. Everything works offline with no account, and sync catches up later.'
          },
          {
            label: 'Price',
            value:
              'Free for local use. Encrypted sync is $5 a month or $48 a year (Plus), $10 a month (Pro), or $500 once (Believer).'
          },
          {
            label: 'Best for',
            value:
              'People who want notes, tasks, journal, and calendar in one calm, encrypted app on their computer.'
          },
          {
            label: 'Where it falls short',
            value:
              'The iPhone app is in TestFlight beta, and there is no Android, iPad, or web app. The whole app is in beta, there is no sharing or self-hosted sync, and AI features are early. The full list is at the top of this page.'
          }
        ]
      },
      {
        heading: 'How we made this list',
        slug: 'how-we-made-this-list',
        paragraphs: [
          'We make MemryNote, and it is on this list because it is what we recommend for an encrypted workspace that covers your whole day, not only your notes. Every other app here is one we would point a friend to for the situation in its row of the short answer. An app had to meet four criteria:'
        ],
        bullets: [
          'Zero-knowledge: notes can be encrypted on your device with keys the company never holds. Apps that only encrypt traffic and disks, such as Notion and Evernote, are not on the list.',
          'Offline: you can open and edit your notes with no connection. Proton Docs is the exception, a cloud editor included because many people asking this question already use Proton.',
          'Export: you can take every note out at once.',
          'Open formats: the export, or the working copy, is something other tools read, such as Markdown, HTML, or plain text.'
        ],
        callout: {
          type: 'note',
          title: 'How we checked',
          text: "We read each app's pricing page, security documentation, and help center in October 2026, and used what each company says is encrypted rather than third-party reviews. MemryNote's claims were checked against its source code and published sync protocol. Prices are in US dollars unless the app charges in euros, and prices change, so check before you buy. The date at the top is the last full review. If something is wrong, email support@memrynote.com and we will fix it."
        }
      }
    ],
    faqs: [
      {
        question: 'What is the most secure end-to-end encrypted notes app?',
        answer:
          'Every app on this list encrypts notes on your device so the provider cannot read them, so the real differences are defaults and metadata. Notesnook, Standard Notes, Anytype, Proton Docs, and MemryNote encrypt by default. Joplin needs encryption turned on, and Obsidian notes are only protected on the server when you sync with an end-to-end encrypted option. Pick the app whose defaults you will not have to remember.'
      },
      {
        question: 'Which end-to-end encrypted notes apps work offline?',
        answer:
          'Joplin, Anytype, Obsidian, and MemryNote are local-first, so everything works without a connection. Notesnook and Standard Notes keep a local copy and work offline, but are built around their accounts. Proton Docs is a cloud editor.'
      },
      {
        question: 'Which encrypted notes app keeps notes as plain Markdown files?',
        answer:
          'Obsidian and MemryNote keep notes as plain Markdown files in a folder you choose. Joplin, Notesnook, Standard Notes, and Anytype keep notes in their own storage and offer exports.'
      },
      {
        question: 'Is there a free end-to-end encrypted notes app?',
        answer:
          "Yes. Joplin is free when you sync through your own Dropbox, OneDrive, or server. Notesnook's free plan syncs unlimited notes across unlimited devices. Standard Notes and Anytype have free plans. Obsidian and MemryNote are free to use locally; their encrypted sync is paid, unless you run Self-hosted LiveSync for Obsidian."
      },
      {
        question: 'Is MemryNote end-to-end encrypted?',
        answer:
          'Yes. MemryNote sync is always end-to-end encrypted. Notes, tasks, journal entries, and attachments are encrypted on your device with XChaCha20-Poly1305, and the server stores only ciphertext plus the metadata it needs to route it. Local use needs no account.'
      },
      {
        question: 'Does MemryNote have a mobile app?',
        answer:
          'The iPhone app is in TestFlight beta. MemryNote runs on macOS, Windows, and Linux today. There is no Android, iPad, or web app yet.'
      }
    ],
    takeaways: [
      'End-to-end encryption means only your devices hold the keys. If support can recover your notes, the service can read them.',
      'Check the defaults: Joplin needs encryption turned on, and Obsidian is only encrypted on the server when you sync with an encrypted option.',
      'Obsidian and MemryNote keep plain Markdown files on your disk. The others keep their own storage and offer exports.',
      'MemryNote fits if you want notes, tasks, journal, and calendar in one encrypted desktop app, and can live with a beta and an iPhone app still in TestFlight.'
    ],
    relatedFeature: {
      label: 'Read the Security Architecture',
      href: '/security',
      description:
        'How MemryNote derives keys, encrypts every item, and keeps the sync server blind to your content.'
    }
  },
  {
    slug: 'private-notion-alternatives-that-work-offline',
    pageKey: 'blogPrivateNotionAlternatives',
    title: 'Private Notion alternatives that work offline',
    description:
      'A Notion alternative that stays private and works offline: what to check, how memrynote does it, and how Anytype, AFFiNE, and Obsidian differ.',
    summary:
      'What to look for when you leave Notion for privacy or offline reasons, how memrynote covers notes, tasks, and planning without the cloud, and how three other options differ.',
    datePublished: '2026-10-13T09:00:00.000Z',
    dateModified: '2026-10-13T09:00:00.000Z',
    author: DEFAULT_AUTHOR,
    readingTime: '7 min read',
    category: 'Philosophy & Workflows',
    heroTint: 'sky',
    tags: ['Notion', 'Privacy', 'Offline', 'Comparison'],
    featured: false,
    lead: 'Notion is a flexible workspace, but it is cloud-first. Your pages live on its servers in a form the service can read, and the app depends on a connection to work well. People usually start looking for an alternative for one of two reasons: they want their notes to stay private, or they want a workspace that keeps working on a plane. This guide covers what to check, how memrynote approaches both, and how a few other options differ.',
    sections: [
      {
        heading: 'What "private" and "offline" should mean',
        paragraphs: [
          'Private means the company running the sync server cannot read your content. That requires end-to-end encryption, where notes are encrypted on your device and the server only stores ciphertext. Encryption at rest on the vendor side does not meet this bar, because the vendor holds the keys.',
          'Offline means the full workspace runs on your machine: opening, editing, searching, and planning, with no spinner when the connection drops. A cached copy that becomes read-only offline is not the same thing.',
          'There is a third property worth adding to the list: ownership. If your notes are stored as files you can open without the app, leaving later is a folder copy rather than an export project.'
        ]
      },
      {
        heading: 'memrynote: the Notion workflow, on your own disk',
        paragraphs: [
          'memrynote keeps the parts of Notion most people use daily, notes, tasks, and planning, and runs them locally. Notes are Markdown files with frontmatter properties in a vault folder you choose. Tasks live in projects with custom statuses, subtasks, and Kanban, list, and calendar views. A daily journal and a capture inbox sit in the same workspace.',
          'Everything works offline with no account. When you turn on sync, each item is encrypted on your device with XChaCha20-Poly1305 and the server stores only ciphertext. Local use is free and sync starts at $5 a month. The app is open source and runs on macOS, Windows, and Linux.',
          'Switching is built in. Export your Notion workspace as Markdown & CSV, then use the Notion importer in memrynote settings. Pages become Markdown notes and databases become structured notes in your vault.'
        ],
        callout: {
          type: 'note',
          title: 'Shared workspaces are coming',
          text: 'Today memrynote is a private workspace synced across your own devices. Shared vaults and collaboration are on the roadmap, built on the same end-to-end encryption.'
        }
      },
      {
        heading: 'How other private, offline options differ',
        paragraphs: [
          'Anytype is local-first and end-to-end encrypted, built around typed objects. Its working format is its own object store, with Markdown available on export. AFFiNE is an open-source workspace that combines documents and whiteboards, with local and cloud workspaces. Obsidian stores notes as local Markdown files; tasks and calendars come from community plugins, and encrypted sync is a paid add-on.',
          'The right pick depends on how you used Notion. If you mostly wrote documents and tracked your own work, a local workspace that covers notes and tasks together replaces it with the fewest moving parts.'
        ],
        table: {
          headers: ['App', 'Where your notes live', 'Notes + tasks + calendar'],
          rows: [
            ['memrynote', 'Plain Markdown files you own', 'Built in, encrypted sync included'],
            ['Anytype', 'Its own local object store', 'Built from object types and views'],
            ['AFFiNE', 'Local or cloud workspace', 'Docs and whiteboards'],
            ['Obsidian', 'Plain Markdown files you own', 'Through community plugins']
          ]
        }
      },
      {
        heading: 'A simple way to decide',
        paragraphs: [
          'List the three things you open Notion for most often. If they are notes, a task list, and some planning, try memrynote with an imported copy of your workspace for a week. It costs nothing, needs no account, and your Notion workspace stays untouched while you compare.'
        ]
      }
    ],
    takeaways: [
      'A private Notion alternative needs end-to-end encryption, not vendor-side encryption at rest.',
      'Offline should mean the full workspace runs locally, including search and planning.',
      'memrynote covers notes, tasks, a calendar, and a journal locally, with encrypted sync and a built-in Notion importer.',
      'Plain Markdown files make leaving any app later a folder copy instead of an export project.'
    ],
    relatedFeature: {
      label: 'memrynote vs Notion',
      href: '/notion-alternative',
      description:
        'A side-by-side look at memrynote and Notion, with migration steps for your workspace.'
    }
  },
  {
    slug: 'most-private-journaling-apps',
    pageKey: 'blogPrivateJournalingApps',
    title: 'The most private journaling apps in 2026',
    description:
      'What makes a journaling app private: encryption, local storage, and files you can read without the app. memrynote, Day One, and Apple Journal compared.',
    summary:
      'A journal is the most personal thing most people write. What to check before you trust an app with it, how memrynote keeps entries private, and where the other options land.',
    datePublished: '2026-10-13T10:00:00.000Z',
    dateModified: '2026-10-13T10:00:00.000Z',
    author: DEFAULT_AUTHOR,
    readingTime: '7 min read',
    category: 'Philosophy & Workflows',
    heroTint: 'sand',
    tags: ['Journaling', 'Privacy', 'E2EE', 'Comparison'],
    featured: false,
    lead: 'A journal holds things you would not put anywhere else: worries, health notes, relationships, decisions you are still unsure about. That makes privacy the first feature to check, before prompts or streaks. A private journaling app keeps entries readable only by you, works without sending your writing to anyone, and leaves you with files you can still open in twenty years.',
    sections: [
      {
        heading: 'What a private journal needs',
        paragraphs: [
          'End-to-end encryption for anything that leaves your device. Entries should be encrypted before upload, with keys the company never holds. If the service can show your entries in a web dashboard after a password reset, it can read them.',
          'Local storage that works offline. Journaling happens at night, on trains, and in places without signal. The app should open and save entries with no connection.',
          "An exit you can read. A journal is a decades-long record. If the only readable copy lives inside one app's database, the journal lasts as long as that app does. Plain text files avoid that problem."
        ]
      },
      {
        heading: 'memrynote: a daily journal as encrypted Markdown',
        paragraphs: [
          'memrynote stores one journal entry per day as a plain Markdown file in your vault, beside your notes and tasks. Each entry can start from your own templates and prompts, and a side panel shows the schedule, tasks, and linked notes for that date. Highlights and revisit reminders bring past entries back when they are relevant.',
          'Entries never need to leave your device. If you sync, each one is encrypted on your machine with XChaCha20-Poly1305 and the server stores only ciphertext. No company account is needed to journal locally, and local use is free.',
          'Because entries are Markdown files, your journal opens in any text editor and survives any app, including memrynote. You can bring an existing journal with you: memrynote imports Apple Journal, Markdown folders, and other note apps.',
          'memrynote runs on macOS, Windows, and Linux today. Mobile apps are planned, so if you journal mainly on your phone, check the roadmap first.'
        ],
        callout: {
          type: 'tip',
          title: 'Journal next to your day',
          text: 'Keeping the journal in the same vault as tasks and notes means an evening entry can see what you actually did that day, without copying anything between apps.'
        }
      },
      {
        heading: 'How other journaling apps compare',
        paragraphs: [
          'Day One encrypts new journals end to end by default and has apps for iPhone, iPad, Android, Mac, and the web; syncing across devices is part of its paid plans. Apple Journal is built into Apple devices and syncs through iCloud. Standard Notes offers Daily Notebooks for journaling on its paid Productivity plan, inside its encrypted note storage.',
          'All three keep entries in their own app storage, with exports available. If you want entries as plain files on your own disk, or a journal that runs natively on Windows and Linux, memrynote is the option that does both.'
        ],
        table: {
          headers: ['App', 'Where entries live', 'Platforms'],
          rows: [
            ['memrynote', 'Plain Markdown files you own', 'macOS, Windows, Linux'],
            ['Day One', 'Its own app storage', 'iPhone, iPad, Android, Mac, web'],
            ['Apple Journal', 'Its own app storage', 'Apple devices'],
            ['Standard Notes', 'Encrypted app storage', 'Web, desktop, mobile']
          ]
        }
      },
      {
        heading: 'Start with the format',
        paragraphs: [
          'Features change every year; the storage format of your journal is what decides whether you can read it later. Choose an app that encrypts what it uploads and keeps the original as plain text you control. Then pick the prompts and rituals that make you write.'
        ]
      }
    ],
    takeaways: [
      'A private journal needs end-to-end encryption for anything that leaves your device.',
      'Offline writing and local storage matter more for journals than for any other kind of note.',
      'memrynote stores each day as a Markdown file beside your notes and tasks, encrypted whenever it syncs.',
      'The storage format decides whether you can still read your journal decades from now.'
    ],
    relatedFeature: {
      label: 'Explore Memrynote Journal',
      href: '/features/journal',
      description:
        'Daily entries with templates, day context, highlights, and revisit reminders, stored as Markdown.'
    }
  }
]

export function getAllPosts(): readonly BlogPost[] {
  return BLOG_POSTS
}

export function getPostBySlug(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((post) => post.slug === slug)
}

export function getRelatedPosts(currentSlug: string, limit = 2): readonly BlogPost[] {
  return BLOG_POSTS.filter((post) => post.slug !== currentSlug).slice(0, limit)
}

export function getAllCategories(): readonly string[] {
  return Array.from(new Set(BLOG_POSTS.map((post) => post.category)))
}

export function getAllTags(): readonly string[] {
  return Array.from(new Set(BLOG_POSTS.flatMap((post) => post.tags)))
}
