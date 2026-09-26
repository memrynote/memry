import { useCallback, useEffect, useState } from 'react'
import type { AgentMcpStatus } from '@memry/contracts/agent-mcp-channels'
import { SettingsGroup, SettingsHeader } from '@/components/settings/settings-primitives'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

const QUIET_ACTION =
  'shrink-0 rounded-sm text-xs/4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

function maskToken(token: string): string {
  return token.length > 8 ? `${token.slice(0, 4)}••••••••${token.slice(-4)}` : '••••••••'
}

export function AgentMcpSection({ embedded = false }: { embedded?: boolean }) {
  const { t } = useT('settings')
  const [status, setStatus] = useState<AgentMcpStatus | null>(null)
  const [isRotating, setIsRotating] = useState(false)

  useEffect(() => {
    let cancelled = false

    void window.api.agentMcp.getStatus().then((nextStatus) => {
      if (!cancelled) setStatus(nextStatus)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const handleRotate = useCallback(async () => {
    setIsRotating(true)
    try {
      setStatus(await window.api.agentMcp.rotateToken())
    } finally {
      setIsRotating(false)
    }
  }, [])

  const toolCount = status?.toolCount ?? 0
  const running = Boolean(status?.url)
  const unavailable = t('agentMcp.notRunning')
  const url = status?.url ?? unavailable
  const bearer = status?.token ?? unavailable
  const urlLabel = t('agentMcp.fields.url.label')
  const bearerLabel = t('agentMcp.fields.bearer.label')
  const rotateLabel = t('agentMcp.actions.rotate.label')

  return (
    <div>
      {!embedded && (
        <SettingsHeader
          title={t('agentMcp.header.title')}
          subtitle={t('agentMcp.header.subtitle')}
        />
      )}

      <div className="flex flex-wrap items-baseline gap-x-2 pb-1.5">
        <h4 className="font-semibold text-xs/4 text-foreground">{t('agentMcp.header.title')}</h4>
        <span className="text-xs/4 text-muted-foreground">{t('agentMcp.v2.hint')}</span>
      </div>
      <SettingsGroup>
        <div className="flex min-h-11 items-center gap-2 py-2.5">
          <span
            aria-hidden
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              running ? 'bg-green-500' : 'border border-muted-foreground/60'
            )}
          />
          <span className="text-[13px]/4 text-foreground">
            {running ? t('agentMcp.v2.running') : unavailable}
          </span>
          {status && (
            <span className="text-xs/4 text-muted-foreground">
              {t('agentMcp.toolsBadge', { count: toolCount })}
            </span>
          )}
        </div>
        <div className="flex min-h-11 items-center justify-between gap-4 py-2.5">
          <span className="shrink-0 text-[13px]/4 text-foreground">{urlLabel}</span>
          <div className="flex min-w-0 items-center gap-3">
            <code className="min-w-0 truncate font-mono text-xs/4 text-foreground" title={url}>
              {url}
            </code>
            <CopyAction label={urlLabel} value={url} disabled={status === null} />
          </div>
        </div>
        <div className="flex min-h-14 items-center justify-between gap-4 py-2.5">
          <div className="flex shrink-0 flex-col gap-0.5">
            <span className="text-[13px]/4 text-foreground">{bearerLabel}</span>
            <span className="text-xs/4 text-muted-foreground">{t('agentMcp.v2.tokenHint')}</span>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <code className="min-w-0 truncate font-mono text-xs/4 text-foreground">
              {status?.token ? maskToken(status.token) : bearer}
            </code>
            <CopyAction label={bearerLabel} value={bearer} disabled={status === null} />
            <button
              type="button"
              className={QUIET_ACTION}
              aria-label={rotateLabel}
              title={t('agentMcp.actions.rotate.description')}
              onClick={() => void handleRotate()}
              disabled={isRotating}
            >
              {t('agentMcp.v2.rotate')}
            </button>
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}

function CopyAction({
  label,
  value,
  disabled
}: {
  label: string
  value: string
  disabled: boolean
}) {
  const { t } = useT('settings')
  const copyLabel = t('agentMcp.copyLabel', { label })

  return (
    <button
      type="button"
      className={QUIET_ACTION}
      aria-label={copyLabel}
      title={copyLabel}
      disabled={disabled}
      onClick={() => void navigator.clipboard.writeText(value)}
    >
      {t('agentMcp.v2.copy')}
    </button>
  )
}
