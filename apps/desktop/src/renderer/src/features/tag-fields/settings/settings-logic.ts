/**
 * Pure rules behind the tag settings sheet: which parents a tag may extend,
 * how a typed field name meets the vault's existing properties, and what the
 * template preview shows.
 */
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { tagDisplayName } from '../tag-display-name'

/** A parent is out when it is the tag itself or already descends from it (a loop). */
export function isExtendsCandidateDisabled(
  snapshot: TagSchemaSnapshot | undefined,
  tag: string,
  candidate: string
): boolean {
  const key = tag.toLowerCase()
  const candidateKey = candidate.toLowerCase()
  if (candidateKey === key) return true
  return snapshot?.tags[candidateKey]?.ancestors.includes(key) ?? false
}

/**
 * The vault property a typed name lands on. Names are case-sensitive keys, so
 * an exact match wins; otherwise a case-only variant is returned so the UI
 * reuses the existing casing instead of creating a near-duplicate.
 */
export function findPropertyByName<T extends { name: string }>(
  name: string,
  properties: readonly T[]
): T | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const exact = properties.find((property) => property.name === trimmed)
  if (exact) return exact
  const folded = trimmed.toLowerCase()
  return properties.find((property) => property.name.toLowerCase() === folded) ?? null
}

/** "Use Client status instead": the tag's name in front of the field name. */
export function alternativeFieldName(tagName: string, fieldName: string): string {
  return `${tagDisplayName(tagName)} ${fieldName.trim().toLowerCase()}`
}

export interface TemplatePreviewSection {
  heading: string
  /** The first line under the heading, or null when the section is empty. */
  hint: string | null
}

/** Each markdown heading of a template body with the first line written under it. */
export function templatePreview(content: string): TemplatePreviewSection[] {
  const sections: TemplatePreviewSection[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      sections.push({ heading: heading[1].trim(), hint: null })
      continue
    }
    const current = sections.at(-1)
    if (current && current.hint === null && line) current.hint = line
  }
  return sections
}
