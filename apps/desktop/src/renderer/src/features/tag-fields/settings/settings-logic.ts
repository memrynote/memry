import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { tagDisplayName } from '../tag-display-name'

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

export function alternativeFieldName(tagName: string, fieldName: string): string {
  return `${tagDisplayName(tagName)} ${fieldName.trim().toLowerCase()}`
}

export interface TemplatePreviewSection {
  heading: string
  hint: string | null
}

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
