import { nameKey } from './note-names.ts'

/**
 * `name`, or `name 2`, `name 3`, ... for the first spelling whose `nameKey`
 * (NFC, collapsed whitespace, case-folded) is not in `takenKeys`. Duplicating a
 * template runs this so the copy never lands on another template's name.
 */
export function uniqueTemplateName(name: string, takenKeys: ReadonlySet<string>): string {
  const base = name.trim()
  let candidate = base
  for (let n = 2; takenKeys.has(nameKey(candidate) ?? ''); n++) candidate = `${base} ${n}`
  return candidate
}
