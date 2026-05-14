export const BASE_URL = 'https://memrynote.com'
export const SITE_NAME = 'Memry'
export const TWITTER_HANDLE = '@h4yfans'
export const SOCIAL_IMAGE_PATH = '/og-image.png'
export const SOCIAL_IMAGE_URL = `${BASE_URL}${SOCIAL_IMAGE_PATH}`
export const SOCIAL_IMAGE_WIDTH = '1200'
export const SOCIAL_IMAGE_HEIGHT = '630'
export const SOCIAL_IMAGE_ALT =
  'memry social preview with the headline Your thoughts, beautifully organized.'

interface PageMeta {
  title: string
  description: string
  path: string
}

export const PAGE_META: Record<string, PageMeta> = {
  home: {
    title: 'Memry — Notes, tasks & journal in one local-first app',
    description:
      'A local-first PKM that replaces your note app, task manager, and journal. Open source, end-to-end encrypted, yours forever.',
    path: '/'
  },
  features: {
    title: 'Features — Memry',
    description:
      'Inbox, notes, tasks & journal — four pillars of thought in one app. Wiki-links, Kanban, daily journal, AI clustering, all local-first.',
    path: '/features'
  },
  useCases: {
    title: 'Use Cases — Memry',
    description:
      'Built for knowledge workers, students, freelancers, and personal productivity. One app that adapts to how you think.',
    path: '/use-cases'
  },
  security: {
    title: 'Security & Privacy — Memry',
    description:
      'Local-first storage, XChaCha20-Poly1305 encryption, zero-knowledge sync, on-device AI. Your data never leaves your device unencrypted.',
    path: '/security'
  },
  pricing: {
    title: 'Pricing — Memry Sync',
    description:
      'Local-first stays free, forever. Plus adds 1 GB sync, Pro adds 10 GB and 10 vaults, and Believer supports independent software with 50 GB and unlimited vaults.',
    path: '/pricing'
  },
  terms: {
    title: 'Terms of Service — Memry',
    description:
      'The agreement between you and Memry when you use the local app and Sync service. Plain-English terms covering accounts, billing, lapse policy, and acceptable use.',
    path: '/terms'
  },
  privacy: {
    title: 'Privacy Policy — Memry',
    description:
      'How Memry handles your data. The local app collects nothing. Sync uploads only ciphertext encrypted on your device. Keys never touch our servers.',
    path: '/privacy'
  },
  refund: {
    title: 'Refund Policy — Memry',
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
    name: 'Memry',
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
      name: 'Memry',
      url: BASE_URL
    }
  })
}
