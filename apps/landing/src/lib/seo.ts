export const BASE_URL = 'https://memrynote.com'
export const SITE_NAME = 'Memry'
export const TWITTER_HANDLE = '@h4yfans'
export const SOCIAL_IMAGE_PATH = '/og-image.png'
export const SOCIAL_IMAGE_URL = `${BASE_URL}${SOCIAL_IMAGE_PATH}`
export const SOCIAL_IMAGE_WIDTH = '1200'
export const SOCIAL_IMAGE_HEIGHT = '630'
export const SOCIAL_IMAGE_ALT =
  'Memry app preview showing notes, tasks, and journal in one local-first workspace.'

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
        description: 'Free tier — unlimited notes, tasks, journal & inbox'
      },
      {
        '@type': 'Offer',
        price: '5',
        priceCurrency: 'USD',
        description: 'Pro — sync, collaboration, publishing'
      }
    ],
    author: {
      '@type': 'Organization',
      name: 'Memry',
      url: BASE_URL
    }
  })
}
