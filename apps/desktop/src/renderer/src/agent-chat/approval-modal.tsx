import { useState } from 'react'

import type { ApproveToolDecision } from '@memry/contracts/ipc-agent'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useAgentOptional } from './agent-context'

const updateToolNames = new Set(['vault_move_to_folder', 'vault_add_tag', 'vault_remove_tag'])

function isUpdateTool(name: string): boolean {
  return name.startsWith('vault_update_') || updateToolNames.has(name)
}

function formatArgs(args: unknown): string {
  return JSON.stringify(args, null, 2)
}

export function ApprovalModal(): React.JSX.Element | null {
  const agent = useAgentOptional()
  const pending = agent?.state.pendingApprovals[0]
  const [editing, setEditing] = useState(false)
  const [edited, setEdited] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)

  if (!agent || !pending || pending.requiresDiff) return null

  const currentAgent = agent
  const currentPending = pending
  const updateTool = isUpdateTool(currentPending.name)
  const approvalLabel = updateTool ? 'Apply once' : 'Allow once'
  const editLabel = updateTool ? 'Edit and apply' : 'Edit and allow'

  function startEditing(): void {
    setEditing(true)
    setEdited(formatArgs(currentPending.args))
    setParseError(null)
  }

  async function respond(decision: ApproveToolDecision): Promise<void> {
    setParseError(null)
    await currentAgent.approveTool({
      conversationId: currentPending.conversationId,
      toolCallId: currentPending.toolCallId,
      decision
    })
    setEditing(false)
    setEdited('')
  }

  function submitEditedArgs(): void {
    try {
      void respond({ kind: 'edit_allow', editedArgs: JSON.parse(edited) })
    } catch {
      setParseError('Enter valid JSON before applying edits.')
    }
  }

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open) void respond({ kind: 'deny' })
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Allow {currentPending.name}?</DialogTitle>
          <DialogDescription>
            The agent wants to call <code>{currentPending.name}</code> with these arguments.
          </DialogDescription>
        </DialogHeader>

        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={edited}
              onChange={(event) => {
                setEdited(event.target.value)
                setParseError(null)
              }}
              rows={10}
              className="font-mono text-xs"
            />
            {parseError && <p className="text-xs text-destructive">{parseError}</p>}
          </div>
        ) : (
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
            {formatArgs(currentPending.args)}
          </pre>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={() => void respond({ kind: 'allow' })}>
            {approvalLabel}
          </Button>
          {!updateTool && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void respond({ kind: 'allow_always' })}
            >
              Allow always
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={editing ? submitEditedArgs : startEditing}
          >
            {editing ? 'Apply edits' : editLabel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void respond({ kind: 'deny' })}
          >
            Deny
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
