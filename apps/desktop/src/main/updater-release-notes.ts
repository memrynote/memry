import { htmlToPlainText } from './lib/html-to-plain-text'

export function stripDeveloperChangelog(text: string): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.trim().toLowerCase() === 'changelog')
  if (index === -1) {
    return text
  }
  return lines.slice(0, index).join('\n').trimEnd()
}

/**
 * The modal body: plain text with the developer changelog dropped. Shared so a
 * Velopack release and an electron-updater release read identically in the prompt.
 */
export function plainTextReleaseNotes(html: string): string | null {
  return stripDeveloperChangelog(htmlToPlainText(html)) || null
}
