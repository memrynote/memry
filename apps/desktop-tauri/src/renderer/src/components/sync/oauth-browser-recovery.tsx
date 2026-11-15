import { useState } from 'react'
import type { InitOAuthResult } from '@memry/contracts/ipc-auth'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface OAuthBrowserRecoveryProps {
  session: InitOAuthResult
  onRetry: () => Promise<void>
  onCancel: () => void
}

export function OAuthBrowserRecovery({ session, onRetry, onCancel }: OAuthBrowserRecoveryProps) {
  const { t } = useT('settings')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [isRetrying, setIsRetrying] = useState(false)

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(session.authorizationUrl)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
  }

  async function retryBrowser(): Promise<void> {
    setIsRetrying(true)
    try {
      await onRetry()
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <div className="space-y-3 text-start">
      <output className="block text-sm text-foreground">
        {t(session.browserOpened ? 'setup.oauth.waiting' : 'setup.oauth.browserUnavailable')}
      </output>
      <p className="text-xs text-muted-foreground">{t('setup.oauth.manualInstructions')}</p>
      <Input
        aria-label={t('setup.oauth.linkLabel')}
        dir="ltr"
        readOnly
        value={session.authorizationUrl}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void copyLink()
          }}
        >
          {t('setup.oauth.copyLink')}
        </Button>
        <Button
          variant="outline"
          disabled={isRetrying}
          onClick={() => {
            void retryBrowser()
          }}
        >
          {t('setup.oauth.retryBrowser')}
        </Button>
      </div>
      {copyStatus === 'copied' && (
        <output className="block text-xs text-muted-foreground">{t('setup.oauth.copied')}</output>
      )}
      {copyStatus === 'failed' && (
        <p className="text-xs text-destructive" role="alert">
          {t('setup.oauth.copyFailed')}
        </p>
      )}
      <Button variant="ghost" onClick={onCancel}>
        {t('setup.oauth.cancel')}
      </Button>
    </div>
  )
}
