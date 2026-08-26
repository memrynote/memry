import { Suspense, type ReactNode } from 'react'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { PageGlow } from '@/components/shared/PageGlow'

/**
 * The chrome every page renders inside.
 *
 * It lives here because two entry points render it — App for the browser,
 * entry-server for the prerender — and the markup they produce has to be
 * identical, character for character, or hydration rejects the prerendered
 * document and rebuilds the page from scratch. The two used to be hand-kept
 * copies and had already drifted (`<main className="flex-1">` server-side
 * against `relative isolate flex-1` on the client, and no PageGlow at all),
 * which is exactly the class of bug this shape rules out.
 *
 * `standalone` is /login: a full-screen card with no header, footer or glow.
 */
export function SiteShell({ standalone, children }: { standalone: boolean; children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      {!standalone && <Header />}
      <main className="relative isolate flex-1">
        {!standalone && <PageGlow />}
        {/* Pages below the entry chunk load on demand (see routes.tsx). Declared on
            both sides so the boundary markers React's SSR writes into the HTML line
            up with the boundary hydration walks into. The fallback is null rather
            than a spinner: it is only ever visible for the moment a chunk is in
            flight during a client-side navigation. */}
        <Suspense fallback={null}>{children}</Suspense>
      </main>
      {!standalone && <Footer />}
    </div>
  )
}
