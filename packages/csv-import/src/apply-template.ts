/**
 * Replace `{{Header}}` placeholders in a template string with row values.
 * Unknown placeholders are left as-is.
 */
export function applyTemplate(template: string, row: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    const trimmed = key.trim()
    return Object.prototype.hasOwnProperty.call(row, trimmed) ? (row[trimmed] ?? '') : _match
  })
}
