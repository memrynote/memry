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

const UNAVAILABLE = 'Not running'

export function AgentMcpSection() {
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
  const url = status?.url ?? UNAVAILABLE
  const bearer = status?.token ?? UNAVAILABLE

  return (
    <div>
      <SettingsHeader
        title="Agent MCP"
        subtitle="Local server access for external MCP clients."
        action={
          status && (
            <span className="rounded-md border border-border bg-muted/50 px-2 py-1 text-xs/4 text-muted-foreground">
              {toolCount} tools
            </span>
          )
        }
      />

      <SettingsGroup label="Connection">
        <SettingRowTall
          label="URL"
          description="Use this localhost endpoint from Cursor, Claude Desktop, or Zed."
        >
          <ValueLine label="URL" value={url} />
        </SettingRowTall>
        <SettingRowTall
          label="Bearer token"
          description="In-memory credential for this app launch."
        >
          <ValueLine label="bearer token" value={bearer} />
        </SettingRowTall>
      </SettingsGroup>

      <SettingsGroup label="Access">
        <SettingRow
          label="Rotate token"
          description="Invalidate existing external-client sessions."
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleRotate}
            disabled={isRotating}
          >
            <RefreshCw className="size-3.5" />
            Rotate token
          </Button>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}

function ValueLine({ label, value }: { label: string; value: string }) {
  const canCopy = value !== UNAVAILABLE

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
      <code className="min-w-0 flex-1 break-all font-mono text-xs/4 text-foreground">{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        disabled={!canCopy}
        onClick={() => void navigator.clipboard.writeText(value)}
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  )
}
