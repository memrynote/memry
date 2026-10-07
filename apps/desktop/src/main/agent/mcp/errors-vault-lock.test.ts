import { describe, expect, it } from 'vitest'
import { VAULT_LOCKED_NOTE_MESSAGE } from '@memry/contracts/vault-locks-api'
import { NoteError, NoteErrorCode } from '../../lib/errors'
import { folderLockedError } from '../../vault-locks/registry'
import { AgentToolError, toMcpToolErrorContent } from './errors'

function parsed(err: unknown): { code: string; message: string } {
  const content = toMcpToolErrorContent(err)
  return JSON.parse(content.content[0].text) as { code: string; message: string }
}

describe('toMcpToolErrorContent for locked targets (#2606)', () => {
  it('reports a locked note as a permission error that says the owner made it read-only', () => {
    const err = new NoteError(VAULT_LOCKED_NOTE_MESSAGE, NoteErrorCode.READ_ONLY, 'note-1')
    expect(parsed(err)).toEqual({ code: 'PERMISSION_DENIED', message: VAULT_LOCKED_NOTE_MESSAGE })
  })

  it('reports a locked folder with the same fixed text, also when a handle rethrew it', () => {
    expect(parsed(folderLockedError())).toEqual({
      code: 'PERMISSION_DENIED',
      message: VAULT_LOCKED_NOTE_MESSAGE
    })
    expect(parsed(new Error(VAULT_LOCKED_NOTE_MESSAGE))).toEqual({
      code: 'PERMISSION_DENIED',
      message: VAULT_LOCKED_NOTE_MESSAGE
    })
  })

  it('keeps other failures as they were', () => {
    expect(parsed(new Error('disk full')).code).toBe('INTERNAL')
    expect(parsed(new AgentToolError('VALIDATION', 'bad')).code).toBe('VALIDATION')
  })
})
