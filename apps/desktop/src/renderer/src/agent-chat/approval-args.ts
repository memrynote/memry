/**
 * Put an edited body back into the tool's own argument shape.
 *
 * `vault_update_note` also has its mode forced to `replace`: the edited text is
 * the whole document the user just read and approved, so appending it to
 * itself is never what they meant.
 */
export function editedArgsWithCandidate(
  args: unknown,
  candidate: string,
  toolName: string
): Record<string, unknown> {
  const base = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  if (toolName === 'vault_add_to_inbox') return { ...base, content: candidate }
  if (toolName === 'vault_update_note') {
    return { ...base, mode: 'replace', content_markdown: candidate }
  }
  return { ...base, content_markdown: candidate }
}
