import { useCallback, useEffect, useState } from 'react'
import type { AgentMcpStatus } from '@memry/contracts/agent-mcp-channels'
import { Copy, RefreshCw } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import {
  SettingsGroup,
  SettingsHeader,
  SettingRow,
  SettingRowTall
} from '@/components/settings/settings-primitives'
import { useT } from '@memry/i18n/renderer'

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
  const unavailable = t('agentMcp.notRunning')
  const url = status?.url ?? unavailable
  const bearer = status?.token ?? unavailable
  const urlLabel = t('agentMcp.fields.url.label')
  const bearerLabel = t('agentMcp.fields.bearer.label')

  return (
    <div>
      {!embedded && (
        <SettingsHeader
          title={t('agentMcp.header.title')}
          subtitle={t('agentMcp.header.subtitle')}
          action={
            status && (
              <span className="rounded-md border border-border bg-muted/50 px-2 py-1 text-xs/4 text-muted-foreground">
                {t('agentMcp.toolsBadge', { count: toolCount })}
              </span>
            )
          }
        />
      )}

      <SettingsGroup label={t('agentMcp.groups.connection')}>
        <SettingRowTall label={urlLabel} description={t('agentMcp.fields.url.description')}>
          <ValueLine label={urlLabel} value={url} canCopy={status !== null} />
        </SettingRowTall>
        <SettingRowTall label={bearerLabel} description={t('agentMcp.fields.bearer.description')}>
          <ValueLine label={bearerLabel} value={bearer} canCopy={status !== null} />
        </SettingRowTall>
      </SettingsGroup>

      <SettingsGroup label={t('agentMcp.groups.access')}>
        <SettingRow
          label={t('agentMcp.actions.rotate.label')}
          description={t('agentMcp.actions.rotate.description')}
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void handleRotate()}
            disabled={isRotating}
          >
            <RefreshCw className="size-3.5" />
            {t('agentMcp.actions.rotate.label')}
          </Button>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}

function ValueLine({ label, value, canCopy }: { label: string; value: string; canCopy: boolean }) {
  const { t } = useT('settings')
  const copyLabel = t('agentMcp.copyLabel', { label })

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
      <code className="min-w-0 flex-1 break-all font-mono text-xs/4 text-foreground">{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={copyLabel}
        title={copyLabel}
        disabled={!canCopy}
        onClick={() => void navigator.clipboard.writeText(value)}
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  )
}
