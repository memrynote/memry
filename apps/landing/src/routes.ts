import { lazy, type ComponentType } from 'react'
import { Home } from '@/pages/Home'

/**
 * The route table, and the reason it exists as data rather than as JSX inside App.
 *
 * Every page used to be a static import, so one entry chunk carried all 45 routes'
 * markup and copy — the competitor comparison data alone is ~100KB — and a phone
 * opening the homepage parsed and evaluated the lot before it could paint. Pages are
 * loaded on demand here instead.
 *
 * The catch is that the site is prerendered and then hydrated: if the route's module
 * has not arrived by the time hydration starts, React treats the boundary as suspended
 * and throws away the server HTML it was about to adopt — the prerendered page would
 * blank out and come back. `preloadRoute` is how main.tsx avoids that: it resolves the
 * current path's chunk first, and only then hydrates. So the table has to be
 * introspectable, which is why routes are values here and JSX in App.
 */
export type PageComponent = ComponentType & { preload: () => Promise<unknown> }

function lazyPage<K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  exportName: K
): PageComponent {
  const loader = () => load().then((module) => ({ default: module[exportName] }))
  const Component = lazy(loader) as unknown as PageComponent
  Component.preload = loader
  return Component
}

/** Home is the entry point for most visits and stays in the entry chunk. */
const HomePage = Object.assign(Home, { preload: () => Promise.resolve() }) as PageComponent

const AlternativePages = {
  obsidian: lazyPage(() => import('@/pages/AlternativePage'), 'ObsidianAlternativePage'),
  notion: lazyPage(() => import('@/pages/AlternativePage'), 'NotionAlternativePage'),
  noteplan: lazyPage(() => import('@/pages/AlternativePage'), 'NotePlanAlternativePage'),
  capacities: lazyPage(() => import('@/pages/AlternativePage'), 'CapacitiesAlternativePage'),
  evernote: lazyPage(() => import('@/pages/AlternativePage'), 'EvernoteAlternativePage'),
  logseq: lazyPage(() => import('@/pages/AlternativePage'), 'LogseqAlternativePage'),
  anytype: lazyPage(() => import('@/pages/AlternativePage'), 'AnytypeAlternativePage'),
  appleNotes: lazyPage(() => import('@/pages/AlternativePage'), 'AppleNotesAlternativePage'),
  bear: lazyPage(() => import('@/pages/AlternativePage'), 'BearAlternativePage'),
  roam: lazyPage(() => import('@/pages/AlternativePage'), 'RoamAlternativePage'),
  onenote: lazyPage(() => import('@/pages/AlternativePage'), 'OneNoteAlternativePage'),
  upnote: lazyPage(() => import('@/pages/AlternativePage'), 'UpNoteAlternativePage'),
  joplin: lazyPage(() => import('@/pages/AlternativePage'), 'JoplinAlternativePage'),
  googleKeep: lazyPage(() => import('@/pages/AlternativePage'), 'GoogleKeepAlternativePage'),
  tana: lazyPage(() => import('@/pages/AlternativePage'), 'TanaAlternativePage'),
  heptabase: lazyPage(() => import('@/pages/AlternativePage'), 'HeptabaseAlternativePage')
}

const BlogPages = {
  index: lazyPage(() => import('@/pages/BlogIndex'), 'BlogIndexPage'),
  journalLongevity: lazyPage(() => import('@/pages/BlogPost'), 'JournalLongevityPostPage'),
  e2eEncryption: lazyPage(() => import('@/pages/BlogPost'), 'E2EEncryptionPostPage'),
  localFirstOffline: lazyPage(() => import('@/pages/BlogPost'), 'LocalFirstOfflinePostPage'),
  terminalPkm: lazyPage(() => import('@/pages/BlogPost'), 'TerminalPkmPostPage'),
  markdownMigration: lazyPage(() => import('@/pages/BlogPost'), 'MarkdownMigrationPostPage')
}

/** Routes whose element is just a page component, in the order App renders them. */
export const PAGE_ROUTES: readonly { path: string; Component: PageComponent }[] = [
  { path: '/', Component: HomePage },
  { path: '/features', Component: lazyPage(() => import('@/pages/Features'), 'FeaturesPage') },
  {
    path: '/features/notes',
    Component: lazyPage(() => import('@/pages/Notes'), 'NotesFeaturePage')
  },
  {
    path: '/features/inbox',
    Component: lazyPage(() => import('@/pages/Inbox'), 'InboxFeaturePage')
  },
  {
    path: '/features/journal',
    Component: lazyPage(() => import('@/pages/Journal'), 'JournalFeaturePage')
  },
  {
    path: '/features/tasks',
    Component: lazyPage(() => import('@/pages/Tasks'), 'TasksFeaturePage')
  },
  {
    path: '/features/calendar',
    Component: lazyPage(() => import('@/pages/Calendar'), 'CalendarFeaturePage')
  },
  {
    path: '/features/ai-agent',
    Component: lazyPage(() => import('@/pages/AIAgent'), 'AIAgentFeaturePage')
  },
  {
    path: '/features/web-clipper',
    Component: lazyPage(() => import('@/pages/WebClipper'), 'WebClipperFeaturePage')
  },
  {
    path: '/download/desktop',
    Component: lazyPage(() => import('@/pages/DownloadDesktop'), 'DownloadDesktopPage')
  },
  { path: '/cli', Component: lazyPage(() => import('@/pages/Cli'), 'CliPage') },
  { path: '/use-cases', Component: lazyPage(() => import('@/pages/UseCases'), 'UseCasesPage') },
  { path: '/security', Component: lazyPage(() => import('@/pages/Security'), 'SecurityPage') },
  { path: '/compare', Component: lazyPage(() => import('@/pages/ComparePage'), 'ComparePage') },
  { path: '/obsidian-alternative', Component: AlternativePages.obsidian },
  { path: '/notion-alternative', Component: AlternativePages.notion },
  { path: '/noteplan-alternative', Component: AlternativePages.noteplan },
  { path: '/capacities-alternative', Component: AlternativePages.capacities },
  { path: '/evernote-alternative', Component: AlternativePages.evernote },
  { path: '/logseq-alternative', Component: AlternativePages.logseq },
  { path: '/anytype-alternative', Component: AlternativePages.anytype },
  { path: '/apple-notes-alternative', Component: AlternativePages.appleNotes },
  { path: '/bear-alternative', Component: AlternativePages.bear },
  { path: '/roam-research-alternative', Component: AlternativePages.roam },
  { path: '/onenote-alternative', Component: AlternativePages.onenote },
  { path: '/upnote-alternative', Component: AlternativePages.upnote },
  { path: '/joplin-alternative', Component: AlternativePages.joplin },
  { path: '/google-keep-alternative', Component: AlternativePages.googleKeep },
  { path: '/tana-alternative', Component: AlternativePages.tana },
  { path: '/heptabase-alternative', Component: AlternativePages.heptabase },
  { path: '/pricing', Component: lazyPage(() => import('@/pages/Pricing'), 'PricingPage') },
  { path: '/checkout', Component: lazyPage(() => import('@/pages/Checkout'), 'CheckoutPage') },
  { path: '/changelog', Component: lazyPage(() => import('@/pages/Changelog'), 'ChangelogPage') },
  { path: '/roadmap', Component: lazyPage(() => import('@/pages/Roadmap'), 'RoadmapPage') },
  { path: '/terms', Component: lazyPage(() => import('@/pages/Terms'), 'TermsPage') },
  { path: '/privacy', Component: lazyPage(() => import('@/pages/Privacy'), 'PrivacyPage') },
  { path: '/refund', Component: lazyPage(() => import('@/pages/Refund'), 'RefundPage') },
  { path: '/blog', Component: BlogPages.index },
  {
    path: '/blog/how-to-keep-a-plain-text-daily-journal-that-outlives-any-app',
    Component: BlogPages.journalLongevity
  },
  {
    path: '/blog/what-end-to-end-encrypted-notes-actually-means',
    Component: BlogPages.e2eEncryption
  },
  {
    path: '/blog/local-first-vs-cloud-first-note-taking-apps',
    Component: BlogPages.localFirstOffline
  },
  {
    path: '/blog/running-a-pkm-from-the-terminal',
    Component: BlogPages.terminalPkm
  },
  {
    path: '/blog/migrating-from-evernote-notion-to-markdown',
    Component: BlogPages.markdownMigration
  },
  { path: '/login', Component: lazyPage(() => import('@/pages/Login'), 'LoginPage') },
  {
    path: '/auth/oauth/callback',
    Component: lazyPage(() => import('@/pages/AuthCallback'), 'AuthCallbackPage')
  }
]

export const NotFoundPage = lazyPage(() => import('@/pages/NotFound'), 'NotFound')

/** The /account subtree renders nothing until RequireAuth has a session, so it can
 *  suspend during hydration without anything visible changing. */
export const AccountLayoutPage = lazyPage(
  () => import('@/components/account/AccountLayout'),
  'AccountLayout'
)
export const ProfileSectionPage = lazyPage(
  () => import('@/pages/account/ProfileSection'),
  'ProfileSection'
)
export const BillingSectionPage = lazyPage(
  () => import('@/pages/account/BillingSection'),
  'BillingSection'
)
export const SyncSectionPage = lazyPage(() => import('@/pages/account/SyncSection'), 'SyncSection')

/**
 * Resolve the chunk the current URL will render, so hydration can wait for it.
 * Unknown paths fall through to NotFound, which is what the router will pick too.
 */
export function preloadRoute(pathname: string): Promise<unknown> {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const match = PAGE_ROUTES.find((route) => route.path === normalized)
  if (match) return match.Component.preload()
  if (normalized === '/account' || normalized.startsWith('/account/')) {
    return AccountLayoutPage.preload()
  }
  // /alternatives and /auth are redirects; they render no page of their own.
  if (normalized === '/alternatives' || normalized === '/auth') return Promise.resolve()
  return NotFoundPage.preload()
}
