import { describe, expect, it } from 'vitest'

import { PROJECT_LINKS } from './project-links'
import { PROJECTS } from './tasks'
import { CALENDAR_EVENTS } from './calendar'
import { NOTE_IDS } from './notes'

const NOTE_ID_SET = new Set<string>(Object.values(NOTE_IDS))
const EVENT_ID_SET = new Set<string>(CALENDAR_EVENTS.map((e) => e.id))
const PROJECT_ID_SET = new Set<string>(PROJECTS.map((p) => p.id))

describe('project links seed data', () => {
  it('links every non-inbox project to notes', () => {
    const linkedProjects = new Set(PROJECT_LINKS.map((l) => l.projectId))
    for (const project of PROJECTS) {
      if (project.isInbox) continue
      expect(linkedProjects.has(project.id)).toBe(true)
    }
  })

  it('points at seeded projects, notes and events', () => {
    for (const link of PROJECT_LINKS) {
      expect(PROJECT_ID_SET.has(link.projectId)).toBe(true)
      if (link.itemType === 'note') {
        expect(NOTE_ID_SET.has(link.itemId)).toBe(true)
      } else if (link.itemType === 'calendar_event') {
        expect(EVENT_ID_SET.has(link.itemId)).toBe(true)
      } else {
        throw new Error(`unexpected seeded link type: ${link.itemType}`)
      }
    }
  })

  it('has unique ids and satisfies the (project, type, item) unique index', () => {
    const ids = PROJECT_LINKS.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)

    const keys = PROJECT_LINKS.map((l) => `${l.projectId}:${l.itemType}:${l.itemId}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('numbers positions from 0 within each project + type group', () => {
    const groups = new Map<string, number[]>()
    for (const link of PROJECT_LINKS) {
      const key = `${link.projectId}:${link.itemType}`
      groups.set(key, [...(groups.get(key) ?? []), link.position])
    }
    for (const positions of groups.values()) {
      expect([...positions].sort((a, b) => a - b)).toEqual(positions.map((_, i) => i))
    }
  })

  it('gives every non-inbox project an existing overview note', () => {
    for (const project of PROJECTS) {
      if (project.isInbox) continue
      expect(project.homeNoteId).toBeTruthy()
      expect(NOTE_ID_SET.has(project.homeNoteId as string)).toBe(true)
    }
  })

  it('never links a project to its own overview note', () => {
    for (const link of PROJECT_LINKS) {
      if (link.itemType !== 'note') continue
      const project = PROJECTS.find((p) => p.id === link.projectId)
      expect(link.itemId).not.toBe(project?.homeNoteId)
    }
  })
})
