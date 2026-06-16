import path from 'node:path'

/**
 * Notion UUIDs come at the end of filenames/URL paths and are 32 hex chars.
 * Exports sometimes dash-format them; strip dashes before matching.
 */
export function getNotionId(name: string): string | undefined {
  return name.replace(/-/g, '').match(/([a-z0-9]{32})(\?|\.|$)/)?.[1]
}

/** Parent-folder ids for a nested entry path, outermost first. */
export function parseParentIds(filepath: string): string[] {
  const parent = path.posix.dirname(filepath)
  if (parent === '.' || parent === '') return []
  return parent
    .split('/')
    .map((segment) => getNotionId(segment))
    .filter((id): id is string => Boolean(id))
}

/**
 * Remove the trailing 32-hex id from a folder/file name, keeping any extension.
 * Internal dashes are preserved so hyphenated titles survive; Notion export
 * filenames use the undashed id form.
 */
export function stripNotionId(name: string): string {
  return name.replace(/ ?[0-9a-f]{32}(\.[^.]*)?$/i, '$1')
}
