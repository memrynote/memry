export const BASE_URL = 'https://memrynote.com'
export const SITE_NAME = 'memrynote'
export const TWITTER_HANDLE = '@h4yfans'
export const SOCIAL_IMAGE_PATH = '/og-image.png'
export const SOCIAL_IMAGE_URL = `${BASE_URL}${SOCIAL_IMAGE_PATH}`
export const SOCIAL_IMAGE_WIDTH = '1200'
export const SOCIAL_IMAGE_HEIGHT = '630'
export const SOCIAL_IMAGE_ALT =
  'memrynote social preview with the headline Your thoughts, beautifully organized.'

interface PageMeta {
  title: string
  description: string
  path: string
}

export const PAGE_META: Record<string, PageMeta> = {
  home: {
    title: 'memrynote — Notes, tasks & journal in one local-first app',
    description:
      'A local-first PKM that replaces your note app, task manager, and journal. Open source, end-to-end encrypted, yours forever.',
    path: '/'
  },
  features: {
    title: 'Features — memrynote',
    description:
      'Inbox, notes, tasks & journal — four pillars of thought in one app. Wiki-links, Kanban, daily journal, AI clustering, all local-first.',
    path: '/features'
  },
  notes: {
    title: 'Notes — memrynote',
    description:
      'A file-first, markdown-native notes app. Wiki-links, backlinks, 8 property types, version history. Plain .md files in a folder you own, local-first.',
    path: '/features/notes'
  },
  inbox: {
    title: 'Inbox — memrynote',
    description:
      'A contemplative space for processing what comes in. Quick capture, voice memos, web clips, PDF extraction, and AI-powered filing — all on your device.',
    path: '/features/inbox'
  },
  journal: {
    title: 'Journal — memrynote',
    description:
      'A reflective daily writing ritual. Day context sidebar, activity heatmap, time-based greetings, monthly stats, and templates. Reflect. Daily.',
    path: '/features/journal'
  },
  tasks: {
    title: 'Tasks — memrynote',
    description:
      'A multi-dimensional task system. Projects, custom statuses, subtasks, recurring schedules, Kanban / Calendar / List views, smart filters. From thought to done.',
    path: '/features/tasks'
  },
  calendar: {
    title: 'Calendar — memrynote',
    description:
      'The calendar view that knows about your tasks, deadlines, and journal entries. Drag-drop rescheduling, due and start dates, day overviews — all from your local vault.',
    path: '/features/calendar'
  },
  aiAgent: {
    title: 'AI Agent — memrynote (Coming soon)',
    description:
      'Chat with your second brain. Local-first, BYOK, MCP-native. Approval-gated writes, conversation-level provider settings, your vault never leaves your device with local models.',
    path: '/features/ai-agent'
  },
  downloadDesktop: {
    title: 'memrynote for Desktop — Coming at the end of June',
    description:
      'memrynote desktop installers for macOS, Windows, and Linux are coming at the end of June. Plain Markdown vault, end-to-end encrypted sync, open source.',
    path: '/download/desktop'
  },
  useCases: {
    title: 'Use Cases — memrynote',
    description:
      'Built for knowledge workers, students, freelancers, and personal productivity. One app that adapts to how you think.',
    path: '/use-cases'
  },
  security: {
    title: 'Security & Privacy — memrynote',
    description:
      'Local-first storage, XChaCha20-Poly1305 encryption, zero-knowledge sync, on-device AI. Your data never leaves your device unencrypted.',
    path: '/security'
  },
  pricing: {
    title: 'Pricing — memrynote Sync',
    description:
      'Local-first stays free, forever. Plus adds 1 GB sync, Pro adds 10 GB and 10 vaults, and Believer supports independent software with 50 GB and unlimited vaults.',
    path: '/pricing'
  },
  roadmap: {
    title: 'Roadmap — Memry',
    description:
      'What is shipping now, what is planned next, and what we have already launched. We update this page as we ship.',
    path: '/roadmap'
  },
  terms: {
    title: 'Terms of Service — memrynote',
    description:
      'The agreement between you and memrynote when you use the local app and Sync service. Plain-English terms covering accounts, billing, lapse policy, and acceptable use.',
    path: '/terms'
  },
  privacy: {
    title: 'Privacy Policy — memrynote',
    description:
      'How memrynote handles your data. The local app collects nothing. Sync uploads only ciphertext encrypted on your device. Keys never touch our servers.',
    path: '/privacy'
  },
  refund: {
    title: 'Refund Policy — memrynote',
    description:
      'Seven-day money-back guarantee on every paid Sync plan, including Believer. Requests processed through Paddle, refunded to your original payment method.',
    path: '/refund'
  }
}

export function getCanonicalUrl(path: string): string {
  return `${BASE_URL}${path}`
}

export function getJsonLd(): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'memrynote',
    applicationCategory: 'ProductivityApplication',
    operatingSystem: 'macOS, Windows, Linux',
    description: PAGE_META.home.description,
    url: BASE_URL,
    offers: [
      {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
        description: 'Free tier — notes, tasks, journal, inbox, and local vault'
      },
      {
        '@type': 'Offer',
        price: '5',
        priceCurrency: 'USD',
        description: 'Plus — 1 GB encrypted sync and 1 vault'
      },
      {
        '@type': 'Offer',
        price: '10',
        priceCurrency: 'USD',
        description: 'Pro — 10 GB encrypted sync and 10 vaults'
      },
      {
        '@type': 'Offer',
        price: '500',
        priceCurrency: 'USD',
        description: 'Believer — supporter package with 50 GB and unlimited vaults'
      }
    ],
    author: {
      '@type': 'Organization',
      name: 'memrynote',
      url: BASE_URL
    }
  })
}
