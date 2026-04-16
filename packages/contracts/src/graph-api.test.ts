/**
 * Graph API Contract Tests
 */

import { describe, it, expect } from 'vitest'
import {
  GraphNodeSchema,
  GraphEdgeSchema,
  GraphDataResponseSchema,
  LocalGraphRequestSchema,
  GraphSettingsSchema,
  GRAPH_SETTINGS_DEFAULTS
} from './graph-api'

describe('GraphNodeSchema', () => {
  it('accepts minimal valid input', () => {
    const result = GraphNodeSchema.safeParse({
      id: 'n1',
      type: 'note',
      label: 'My Note',
      tags: [],
      wordCount: 0,
      connectionCount: 0,
      emoji: null,
      color: '#fff',
      isOrphan: false,
      isUnresolved: false
    })
    expect(result.success).toBe(true)
  })

  it('accepts all valid node types', () => {
    for (const type of ['note', 'task', 'journal', 'project']) {
      const result = GraphNodeSchema.safeParse({
        id: 'n1',
        type,
        label: 'L',
        tags: [],
        wordCount: 0,
        connectionCount: 0,
        emoji: null,
        color: '#fff',
        isOrphan: false,
        isUnresolved: false
      })
      expect(result.success).toBe(true)
    }
  })

  it('accepts emoji string or null', () => {
    const withEmoji = GraphNodeSchema.safeParse({
      id: 'n1',
      type: 'note',
      label: 'L',
      tags: ['t'],
      wordCount: 10,
      connectionCount: 2,
      emoji: '📝',
      color: '#ff0',
      isOrphan: true,
      isUnresolved: false
    })
    expect(withEmoji.success).toBe(true)
  })

  it('rejects invalid type', () => {
    const result = GraphNodeSchema.safeParse({
      id: 'n1',
      type: 'folder',
      label: 'L',
      tags: [],
      wordCount: 0,
      connectionCount: 0,
      emoji: null,
      color: '#fff',
      isOrphan: false,
      isUnresolved: false
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('type')
    }
  })

  it('rejects empty id', () => {
    const result = GraphNodeSchema.safeParse({
      id: '',
      type: 'note',
      label: 'L',
      tags: [],
      wordCount: 0,
      connectionCount: 0,
      emoji: null,
      color: '#fff',
      isOrphan: false,
      isUnresolved: false
    })
    expect(result.success).toBe(false)
  })

  it('rejects negative wordCount', () => {
    const result = GraphNodeSchema.safeParse({
      id: 'n1',
      type: 'note',
      label: 'L',
      tags: [],
      wordCount: -1,
      connectionCount: 0,
      emoji: null,
      color: '#fff',
      isOrphan: false,
      isUnresolved: false
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer connectionCount', () => {
    const result = GraphNodeSchema.safeParse({
      id: 'n1',
      type: 'note',
      label: 'L',
      tags: [],
      wordCount: 0,
      connectionCount: 1.5,
      emoji: null,
      color: '#fff',
      isOrphan: false,
      isUnresolved: false
    })
    expect(result.success).toBe(false)
  })
})

describe('GraphEdgeSchema', () => {
  it('accepts minimal valid input with default weight', () => {
    const result = GraphEdgeSchema.safeParse({
      id: 'e1',
      source: 'a',
      target: 'b',
      type: 'wikilink'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.weight).toBe(1)
    }
  })

  it('accepts all valid edge types', () => {
    for (const type of ['wikilink', 'task-note', 'project-task', 'tag-cooccurrence']) {
      const result = GraphEdgeSchema.safeParse({
        id: 'e1',
        source: 'a',
        target: 'b',
        type,
        weight: 2
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects invalid edge type', () => {
    const result = GraphEdgeSchema.safeParse({
      id: 'e1',
      source: 'a',
      target: 'b',
      type: 'bogus'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('type')
    }
  })

  it('rejects empty source', () => {
    const result = GraphEdgeSchema.safeParse({
      id: 'e1',
      source: '',
      target: 'b',
      type: 'wikilink'
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty target', () => {
    const result = GraphEdgeSchema.safeParse({
      id: 'e1',
      source: 'a',
      target: '',
      type: 'wikilink'
    })
    expect(result.success).toBe(false)
  })
})

describe('GraphDataResponseSchema', () => {
  it('accepts empty graph', () => {
    const result = GraphDataResponseSchema.safeParse({ nodes: [], edges: [] })
    expect(result.success).toBe(true)
  })

  it('accepts populated graph', () => {
    const result = GraphDataResponseSchema.safeParse({
      nodes: [
        {
          id: 'n1',
          type: 'note',
          label: 'L',
          tags: [],
          wordCount: 0,
          connectionCount: 0,
          emoji: null,
          color: '#fff',
          isOrphan: false,
          isUnresolved: false
        }
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'wikilink', weight: 1 }]
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing edges', () => {
    const result = GraphDataResponseSchema.safeParse({ nodes: [] })
    expect(result.success).toBe(false)
  })
})

describe('LocalGraphRequestSchema', () => {
  it('accepts minimal input with default depth', () => {
    const result = LocalGraphRequestSchema.safeParse({ noteId: 'n1' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.depth).toBe(2)
    }
  })

  it('accepts depth at boundaries (1 and 3)', () => {
    expect(LocalGraphRequestSchema.safeParse({ noteId: 'n1', depth: 1 }).success).toBe(true)
    expect(LocalGraphRequestSchema.safeParse({ noteId: 'n1', depth: 3 }).success).toBe(true)
  })

  it('rejects depth below 1', () => {
    const result = LocalGraphRequestSchema.safeParse({ noteId: 'n1', depth: 0 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('depth')
    }
  })

  it('rejects depth above 3', () => {
    const result = LocalGraphRequestSchema.safeParse({ noteId: 'n1', depth: 4 })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer depth', () => {
    const result = LocalGraphRequestSchema.safeParse({ noteId: 'n1', depth: 2.5 })
    expect(result.success).toBe(false)
  })

  it('rejects empty noteId', () => {
    const result = LocalGraphRequestSchema.safeParse({ noteId: '' })
    expect(result.success).toBe(false)
  })
})

describe('GraphSettingsSchema', () => {
  it('accepts all valid layouts', () => {
    for (const layout of ['forceatlas2', 'circular', 'random']) {
      const result = GraphSettingsSchema.safeParse({
        layout,
        showLabels: true,
        showEdgeLabels: false,
        animateLayout: false,
        showTagEdges: true
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects invalid layout', () => {
    const result = GraphSettingsSchema.safeParse({
      layout: 'grid',
      showLabels: false,
      showEdgeLabels: false,
      animateLayout: false,
      showTagEdges: false
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('layout')
    }
  })

  it('rejects missing boolean field', () => {
    const result = GraphSettingsSchema.safeParse({
      layout: 'forceatlas2',
      showLabels: true,
      showEdgeLabels: false,
      animateLayout: false
    })
    expect(result.success).toBe(false)
  })

  it('GRAPH_SETTINGS_DEFAULTS matches schema', () => {
    const result = GraphSettingsSchema.safeParse(GRAPH_SETTINGS_DEFAULTS)
    expect(result.success).toBe(true)
  })
})
