import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractAnchor, parsePortalDefinition } from '@memry/shared/portal-block'
import { resolvePortal, type ResolverBlock } from '@memry/shared/portal-resolve'
import { scanPortalFences } from '../../src/main/portals/portal-fences'
import { parseNote } from '../../src/main/vault/frontmatter'
import { writeNoteFiles } from '../seed-vault/file-writer'
import { PORTAL_METADATA, PORTAL_NOTES, PORTAL_NOTE_IDS, PORTAL_NOTE_PATHS } from './portals'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The notes as the app first reads them: written files, through `parseNote`. */
function writtenBodies(): Record<string, string> {
  const vault = mkdtempSync(join(tmpdir(), 'portals-seed-'))
  dirs.push(vault)
  writeNoteFiles(vault, PORTAL_NOTES)
  const bodies: Record<string, string> = {}
  for (const [key, path] of Object.entries(PORTAL_NOTE_PATHS)) {
    bodies[PORTAL_NOTE_IDS[key as keyof typeof PORTAL_NOTE_IDS]] = parseNote(
      readFileSync(join(vault, path), 'utf8'),
      path
    ).content
  }
  return bodies
}

/** Bullet lines as resolver blocks: two spaces of indent per level. */
function resolverBlocks(body: string): ResolverBlock[] {
  return body
    .split('\n')
    .filter((line) => /^\s*- /.test(line))
    .map((line) => ({
      depth: (line.length - line.trimStart().length) / 2,
      inline: [{ text: line.trimStart().slice(2) }]
    }))
}

describe('portals seed', () => {
  it('has one metadata row per note, with a unique id and path', () => {
    expect(PORTAL_METADATA).toHaveLength(PORTAL_NOTES.length)
    expect(new Set(PORTAL_METADATA.map((m) => m.id)).size).toBe(PORTAL_METADATA.length)
    expect(new Set(PORTAL_METADATA.map((m) => m.path)).size).toBe(PORTAL_METADATA.length)
  })

  it('writes only fences the app can read, and every one resolves', () => {
    const bodies = writtenBodies()
    let fences = 0
    for (const body of Object.values(bodies)) {
      for (const text of scanPortalFences(body)) {
        fences += 1
        const parsed = parsePortalDefinition(text)
        expect(parsed.ok).toBe(true)
        if (!parsed.ok) continue
        const { target } = parsed.definition
        if (target.kind === 'search') continue
        const source = bodies[target.note]
        expect(source, `source note ${target.note}`).toBeDefined()
        if (target.kind === 'note') continue
        const resolution = resolvePortal(resolverBlocks(source), target)
        expect(resolution.status).toBe('ok')
      }
    }
    expect(fences).toBe(6)
  })

  it('anchors every block a fence names, once', () => {
    const bodies = writtenBodies()
    const anchors = Object.values(bodies).flatMap((body) =>
      resolverBlocks(body).flatMap((b) => extractAnchor(b.inline[0].text) ?? [])
    )
    expect(new Set(anchors).size).toBe(anchors.length)
    for (const body of Object.values(bodies)) {
      for (const text of scanPortalFences(body)) {
        const parsed = parsePortalDefinition(text)
        if (!parsed.ok || parsed.definition.target.kind !== 'blocks') continue
        const { blocks, open } = parsed.definition.target
        const named = [
          ...blocks,
          ...Object.values(open).flatMap((o) => o.ids),
          ...Object.keys(open)
        ]
        for (const anchor of named) expect(anchors).toContain(anchor)
      }
    }
  })

  it('shows the cases the demo is for', () => {
    const bodies = writtenBodies()
    const targets = Object.values(bodies)
      .flatMap((body) => scanPortalFences(body))
      .map((text) => parsePortalDefinition(text))
      .flatMap((p) => (p.ok ? [p.definition.target] : []))
    const kinds = targets.map((t) => t.kind)
    expect(kinds).toContain('note')
    expect(kinds).toContain('search')
    expect(targets.some((t) => t.kind === 'blocks' && t.blocks.length > 1)).toBe(true)
    expect(
      targets.some(
        (t) => t.kind === 'blocks' && Object.values(t.open).some((o) => o.mode === 'show')
      )
    ).toBe(true)
    expect(
      targets.some(
        (t) => t.kind === 'blocks' && Object.values(t.open).some((o) => o.mode === 'hide')
      )
    ).toBe(true)
    expect(bodies[PORTAL_NOTE_IDS.examPrep]).toContain('[[Lecture 1#^dna1]]')
  })
})
