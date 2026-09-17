import { randomBytes } from 'node:crypto'

/**
 * A capability that authorises vault writes over the Vault MCP server.
 *
 * The design contract is that external MCP clients are read-only and writes
 * require an active memrynote Agent conversation. A conversation id cannot carry
 * that contract: it is a stable, persisted identifier that survives the turn
 * that produced it, so anything holding the server's bearer token and one id
 * could write at any time, for as long as the vault stayed open.
 *
 * A grant is instead minted by the turn that is about to run, handed only to the
 * backend that turn spawns, and revoked the moment the turn ends. Presenting one
 * therefore proves the caller is a tool call inside a turn memrynote itself is
 * running, which is exactly what the gate needs to know. It is 256 bits of
 * randomness so it cannot be guessed, and it is never persisted, never sent to
 * the renderer, and never returned by a read tool.
 */
declare const turnWriteGrantBrand: unique symbol
export type TurnWriteGrant = string & { readonly [turnWriteGrantBrand]: true }

/** grant -> the conversation whose in-flight turn it authorises. */
const active = new Map<string, string>()

/**
 * Mint the grant for a turn that is starting. Any grant still held for the same
 * conversation is dropped first: turns are serialized per conversation by the
 * runtime's turn lock, so an older one can only be a leftover from a turn that
 * died without reaching its revoke.
 */
export function mintTurnWriteGrant(conversationId: string): TurnWriteGrant {
  revokeTurnWriteGrantsFor(conversationId)
  const grant = randomBytes(32).toString('hex')
  active.set(grant, conversationId)
  return grant as TurnWriteGrant
}

/**
 * Resolve a client-supplied header value to the conversation it authorises, or
 * null when it names no in-flight turn. Unknown values are indistinguishable
 * from expired ones on purpose: neither may write.
 */
export function resolveTurnWriteGrant(candidate: string | null | undefined): string | null {
  if (!candidate) return null
  return active.get(candidate) ?? null
}

export function revokeTurnWriteGrantsFor(conversationId: string): void {
  for (const [grant, owner] of active) {
    if (owner === conversationId) active.delete(grant)
  }
}

export function revokeAllTurnWriteGrants(): void {
  active.clear()
}
