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

export interface BlogSection {
  heading: string
  slug?: string
  paragraphs: string[]
  bullets?: string[]
  callout?: BlogCallout
  code?: BlogCodeBlock
  table?: BlogComparisonTable
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
  readingTime: string
  category: string
  heroTint: HeroTint
  tags: readonly string[]
  featured?: boolean
  lead: string
  sections: readonly BlogSection[]
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
      'Supercharge your personal knowledge management with a CLI. Query notes, capture tasks from git hooks, append to your daily journal, and automate workflows with Unix pipes.',
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
          'By integrating the CLI into your shell startup configuration (`.zshrc` or `.bashrc`) and git hooks, you can automate repetitive engineering rituals effortlessly.',
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
          '2. Backlink Resolution: Click on internal `[[wiki-links]]` to verify that cross-page navigation connects seamlessly without missing target warnings.',
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
