/** Verifier for `versioned-values.json` (chapter 06 §6.11). */
import { describe, expect, it } from 'vitest'

import {
  canonicalJson,
  compareVersioned,
  joinVersionedMap,
  joinVersionedValue,
  plainVersionedMap,
  stampVersionedMapPatch,
  stampVersionedValue,
  type JsonValue,
  type VersionedObject
} from '../../../shared/src/versioned.ts'
import { loadVectorFile } from './vector-loader'

interface Case {
  name: string
  kind: string
  input: Record<string, unknown>
  expected: Record<string, unknown>
}

const vectors = loadVectorFile<{ meta: { caseCount: number }; cases: Case[] }>(
  'versioned-values.json'
)

function check(c: Case, input: Record<string, unknown>): void {
  switch (c.kind) {
    case 'canonical':
      expect(canonicalJson(input.value)).toBe(c.expected.canonical)
      return
    case 'order':
      expect(Math.sign(compareVersioned(input.a, input.b))).toBe(c.expected.sign)
      expect(Math.sign(compareVersioned(input.b, input.a))).toBe(-(c.expected.sign as number) || 0)
      return
    case 'join-value':
    case 'join-map': {
      const join = c.kind === 'join-value' ? joinVersionedValue : joinVersionedMap
      const joined = join(input.local, input.remote)
      expect({
        value: joined.value,
        remoteBehind: joined.remoteBehind,
        localChanged: joined.localChanged
      }).toEqual(c.expected)
      const swapped = join(input.remote, input.local)
      expect(canonicalJson(swapped.value ?? null)).toBe(canonicalJson(c.expected.value ?? null))
      return
    }
    case 'join-map-associativity': {
      const left = joinVersionedMap(joinVersionedMap(input.a, input.b).value, input.c).value
      const right = joinVersionedMap(input.a, joinVersionedMap(input.b, input.c).value).value
      expect(canonicalJson(left)).toBe(canonicalJson(c.expected.value))
      expect(canonicalJson(right)).toBe(canonicalJson(c.expected.value))
      return
    }
    case 'stamp-map':
      expect(
        stampVersionedMapPatch(
          input.stored,
          input.patch as Record<string, JsonValue>,
          input.clockTotal as number
        )
      ).toEqual(c.expected.value)
      return
    case 'stamp-value':
      expect(stampVersionedValue(input.previous, input.edited as VersionedObject)).toEqual(
        c.expected.value
      )
      return
    case 'plain':
      expect(plainVersionedMap(input.stored)).toEqual(c.expected.plain)
      return
    default:
      throw new Error(`${c.name}: unknown case kind ${c.kind}`)
  }
}

describe('versioned-values vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases.length).toBe(vectors.meta.caseCount)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const input = structuredClone(c.input)
    check(c, input)
    expect(input, 'the functions read their inputs and never write them').toEqual(c.input)
  })
})
