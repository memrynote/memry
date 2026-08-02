import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/contexts/auth-context'

const SUPPORT_EMAIL = 'support@memrynote.com'

interface BillingStatus {
  email: string | null
  plan: string
  status: string
}

export function ProfileSection() {
  const { api, signOutLocal } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState<string>('')
  const [newEmail, setNewEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [emailStep, setEmailStep] = useState<'idle' | 'code'>('idle')
  const [deleteCode, setDeleteCode] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    api
      .authedJson<BillingStatus>('/auth/billing')
      .then((b) => setEmail(b.email ?? ''))
      .catch(() => {})
  }, [api])

  async function requestEmailChange() {
    setMsg(null)
    try {
      await api.authedJson('/auth/email/change', {
        method: 'POST',
        body: JSON.stringify({ newEmail })
      })
      setEmailStep('code')
      setMsg('Code sent to ' + newEmail)
    } catch {
      setMsg('Failed to send code. Try again.')
    }
  }

  async function verifyEmailChange() {
    setMsg(null)
    try {
      await api.authedJson('/auth/email/change/verify', {
        method: 'POST',
        body: JSON.stringify({ newEmail, code: emailCode })
      })
      setEmail(newEmail)
      setEmailStep('idle')
      setNewEmail('')
      setEmailCode('')
      setMsg('Email updated')
    } catch {
      setMsg('Invalid or expired code.')
    }
  }

  async function logoutEverywhere() {
    try {
      await api.authedFetch('/auth/logout-all', { method: 'POST' })
    } catch {
      // best-effort
    }
    signOutLocal()
    navigate('/')
  }

  async function requestDeleteCode() {
    setMsg(null)
    if (!email) {
      // email only populates once /auth/billing loads; without it the OTP would
      // be requested for an empty address and never arrive.
      setMsg('Could not load your account email yet. Reload and try again.')
      return
    }
    try {
      await api.authedJson('/auth/otp/request', {
        method: 'POST',
        body: JSON.stringify({ email })
      })
      setMsg('Confirmation code sent to ' + email)
    } catch {
      setMsg('Failed to send code. Try again.')
    }
  }

  async function deleteAccount() {
    setMsg(null)
    try {
      await api.authedJson('/auth/account', {
        method: 'DELETE',
        body: JSON.stringify({ code: deleteCode })
      })
      signOutLocal()
      navigate('/')
    } catch {
      setMsg('Deletion failed. Try again.')
    }
  }

  return (
    <div className="space-y-8">
      <h1 className="font-editorial text-2xl tracking-[-0.01em]">Profile</h1>
      {/* Status messages ('Code sent to <email>', 'Confirmation code sent to
          <email>') can contain the account email — keep out of session replay. */}
      {msg ? (
        <p className="text-sm text-muted" data-ph-mask>
          {msg}
        </p>
      ) : null}

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold">Email</h2>
        <p className="mt-1 text-sm text-muted" data-ph-mask>
          {email || '—'}
        </p>
        {emailStep === 'idle' ? (
          <div className="mt-4 flex gap-2">
            <Input
              type="email"
              placeholder="new@example.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
            <Button variant="outline" disabled={!newEmail} onClick={requestEmailChange}>
              Change
            </Button>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <Input
              inputMode="numeric"
              placeholder="123456"
              value={emailCode}
              onChange={(e) => setEmailCode(e.target.value)}
            />
            <Button disabled={emailCode.length !== 6} onClick={verifyEmailChange}>
              Confirm
            </Button>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold">Support &amp; sessions</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <a href={`mailto:${SUPPORT_EMAIL}`}>Contact support</a>
          </Button>
          <Button variant="outline" onClick={logoutEverywhere}>
            Log out everywhere
          </Button>
        </div>
      </section>

      <section className="rounded-2xl border border-red-500/30 bg-card p-6">
        <h2 className="text-sm font-semibold text-red-500">Delete account</h2>
        <p className="mt-1 text-sm text-muted">
          This permanently erases your account and synced data. It cannot be undone.
        </p>
        <div className="mt-4 space-y-2">
          <Button variant="outline" disabled={!email} onClick={requestDeleteCode}>
            Email me a confirmation code
          </Button>
          <Input
            inputMode="numeric"
            placeholder="Confirmation code"
            value={deleteCode}
            onChange={(e) => setDeleteCode(e.target.value)}
          />
          <Input
            placeholder='Type "DELETE" to confirm'
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
          />
          <Button
            className="bg-red-500 text-white hover:bg-red-600"
            disabled={confirmText !== 'DELETE' || deleteCode.length !== 6}
            onClick={deleteAccount}
          >
            Delete my account
          </Button>
        </div>
      </section>
    </div>
  )
}
