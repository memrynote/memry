import { NavLink, Outlet, useNavigate } from 'react-router'
import { Container } from '@/components/layout/Container'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { trackLandingEvent } from '@/lib/analytics'

const TABS = [
  { to: '/account/profile', label: 'Profile' },
  { to: '/account/billing', label: 'Billing' },
  { to: '/account/sync', label: 'Sync' }
]

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'block rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    isActive ? 'bg-paper-alt text-ink' : 'text-muted hover:text-ink'
  )

export function AccountLayout() {
  const { api, signOutLocal } = useAuth()
  const navigate = useNavigate()

  async function logout() {
    try {
      await api.authedFetch('/auth/logout', { method: 'POST' })
    } catch {
      // best-effort; clear local session regardless
    }
    signOutLocal()
    trackLandingEvent('landing_account_signout', 'account:logout')
    navigate('/')
  }

  return (
    <main className="py-24">
      <Container size="lg">
        <div className="mx-auto grid max-w-5xl gap-8 md:grid-cols-[200px_1fr]">
          <aside className="flex flex-col gap-1">
            {TABS.map((t) => (
              <NavLink key={t.to} to={t.to} className={linkClass}>
                {t.label}
              </NavLink>
            ))}
            <div className="mt-6 border-t border-border pt-4 space-y-1">
              <button
                type="button"
                onClick={logout}
                className="block w-full rounded-lg px-3 py-2 text-start text-sm font-medium text-muted hover:text-ink"
              >
                Log out
              </button>
              <NavLink
                to="/"
                className="block rounded-lg px-3 py-2 text-sm font-medium text-muted hover:text-ink"
              >
                Back to homepage
              </NavLink>
            </div>
          </aside>
          <section>
            <Outlet />
          </section>
        </div>
      </Container>
    </main>
  )
}
