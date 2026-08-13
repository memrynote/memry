import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Project } from '@/data/tasks-data'
import {
  parsePriorityKeyword,
  findProjectByName,
  findDatePhrase,
  findNoteLinks,
  findQuickAddSpans,
  parseQuickAdd,
  hasSpecialSyntax,
  getParsePreview,
  getPriorityOptions,
  getProjectOptions,
  getTagOptions,
  predictRepeatCompletion
} from './quick-add-parser'

// ============================================================================
// TEST HELPERS
// ============================================================================

const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Test Project',
  description: '',
  icon: 'folder',
  color: '#3b82f6',
  statuses: [],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0,
  ...overrides
})

// ============================================================================
// T105: PRIORITY KEYWORD PARSING
// ============================================================================

describe('parsePriorityKeyword', () => {
  describe('urgent priority', () => {
    it("should parse 'urgent' to 'urgent'", () => {
      expect(parsePriorityKeyword('urgent')).toBe('urgent')
    })

    it("should parse 'u' to 'urgent'", () => {
      expect(parsePriorityKeyword('u')).toBe('urgent')
    })
  })

  describe('high priority', () => {
    it("should parse 'high' to 'high'", () => {
      expect(parsePriorityKeyword('high')).toBe('high')
    })

    it("should parse 'h' to 'high'", () => {
      expect(parsePriorityKeyword('h')).toBe('high')
    })
  })

  describe('medium priority', () => {
    it("should parse 'medium' to 'medium'", () => {
      expect(parsePriorityKeyword('medium')).toBe('medium')
    })

    it("should parse 'med' to 'medium'", () => {
      expect(parsePriorityKeyword('med')).toBe('medium')
    })

    it("should parse 'm' to 'medium'", () => {
      expect(parsePriorityKeyword('m')).toBe('medium')
    })
  })

  describe('low priority', () => {
    it("should parse 'low' to 'low'", () => {
      expect(parsePriorityKeyword('low')).toBe('low')
    })

    it("should parse 'l' to 'low'", () => {
      expect(parsePriorityKeyword('l')).toBe('low')
    })
  })

  describe('none priority', () => {
    it("should parse 'none' to 'none'", () => {
      expect(parsePriorityKeyword('none')).toBe('none')
    })

    it("should parse 'n' to 'none'", () => {
      expect(parsePriorityKeyword('n')).toBe('none')
    })
  })

  describe('case insensitivity', () => {
    it("should parse 'URGENT' to 'urgent'", () => {
      expect(parsePriorityKeyword('URGENT')).toBe('urgent')
    })

    it("should parse 'High' to 'high'", () => {
      expect(parsePriorityKeyword('High')).toBe('high')
    })

    it("should parse 'MED' to 'medium'", () => {
      expect(parsePriorityKeyword('MED')).toBe('medium')
    })
  })

  describe('invalid keywords', () => {
    it("should return null for 'invalid'", () => {
      expect(parsePriorityKeyword('invalid')).toBeNull()
    })

    it("should return null for 'xxx'", () => {
      expect(parsePriorityKeyword('xxx')).toBeNull()
    })

    it('should return null for empty string', () => {
      expect(parsePriorityKeyword('')).toBeNull()
    })

    it('should return null for whitespace', () => {
      expect(parsePriorityKeyword('  ')).toBeNull()
    })
  })
})

// ============================================================================
// T106: PROJECT NAME PARSING
// ============================================================================

describe('findProjectByName', () => {
  const projects: Project[] = [
    createMockProject({ id: 'project-1', name: 'Test Project' }),
    createMockProject({ id: 'work', name: 'Work' }),
    createMockProject({ id: 'personal', name: 'Personal Tasks' }),
    createMockProject({ id: 'project-alpha', name: 'Project Alpha' })
  ]

  describe('exact ID match', () => {
    it("should find project by exact ID 'project-1'", () => {
      const result = findProjectByName('project-1', projects)
      expect(result).toBe('project-1')
    })

    it("should find project by exact ID 'work'", () => {
      const result = findProjectByName('work', projects)
      expect(result).toBe('work')
    })

    it('should be case-insensitive for ID match', () => {
      const result = findProjectByName('WORK', projects)
      expect(result).toBe('work')
    })
  })

  describe('exact name match (case-insensitive)', () => {
    it("should find project by exact name 'Test Project'", () => {
      const result = findProjectByName('Test Project', projects)
      expect(result).toBe('project-1')
    })

    it("should find project by lowercase name 'test project'", () => {
      const result = findProjectByName('test project', projects)
      expect(result).toBe('project-1')
    })

    it("should find project by uppercase name 'TEST PROJECT'", () => {
      const result = findProjectByName('TEST PROJECT', projects)
      expect(result).toBe('project-1')
    })
  })

  describe('partial name match (starts with)', () => {
    it("should find project starting with 'Test'", () => {
      const result = findProjectByName('Test', projects)
      expect(result).toBe('project-1')
    })

    it("should find project starting with 'Personal'", () => {
      const result = findProjectByName('Personal', projects)
      expect(result).toBe('personal')
    })

    it("should find project starting with 'project' (matches first partial)", () => {
      const result = findProjectByName('project', projects)
      // Partial match searches project names, not IDs - "Project Alpha" starts with "project"
      expect(result).toBe('project-alpha')
    })
  })

  describe('kebab-case name match', () => {
    it("should find 'Test Project' using 'test-project'", () => {
      const result = findProjectByName('test-project', projects)
      expect(result).toBe('project-1')
    })

    it("should find 'Personal Tasks' using 'personal-tasks'", () => {
      const result = findProjectByName('personal-tasks', projects)
      expect(result).toBe('personal')
    })

    it("should find 'Project Alpha' using 'project-alpha'", () => {
      const result = findProjectByName('project-alpha', projects)
      expect(result).toBe('project-alpha')
    })
  })

  describe('not found cases', () => {
    it('should return null for non-existent project', () => {
      const result = findProjectByName('nonexistent', projects)
      expect(result).toBeNull()
    })

    it('should return null for empty projects array', () => {
      const result = findProjectByName('work', [])
      expect(result).toBeNull()
    })

    it('should match first project when empty name (starts with empty string)', () => {
      // Empty string matches first project via startsWith (all names start with "")
      const result = findProjectByName('', projects)
      expect(result).toBe('project-1')
    })
  })
})

// ============================================================================
// T107: MAIN PARSER - parseQuickAdd
// ============================================================================

describe('parseQuickAdd', () => {
  const projects: Project[] = [
    createMockProject({ id: 'work', name: 'Work' }),
    createMockProject({ id: 'personal', name: 'Personal' })
  ]

  beforeEach(() => {
    // Saturday, 10 January 2026.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 10))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('basic parsing', () => {
    it('should parse simple title without syntax', () => {
      const result = parseQuickAdd('Buy groceries', projects)
      expect(result).toEqual({
        title: 'Buy groceries',
        dueDate: null,
        dueTime: null,
        priority: 'none',
        projectId: null,
        repeat: null,
        tags: [],
        noteTitles: []
      })
    })

    it('should preserve title without special syntax', () => {
      const result = parseQuickAdd('Complete the project report', projects)
      expect(result.title).toBe('Complete the project report')
    })
  })

  // --------------------------------------------------------------------------
  // ! — priority
  // --------------------------------------------------------------------------

  describe('priority', () => {
    it("reads '!high' and takes it out of the title", () => {
      const result = parseQuickAdd('Buy groceries !high', projects)
      expect(result.title).toBe('Buy groceries')
      expect(result.priority).toBe('high')
    })

    it("reads '!urgent'", () => {
      const result = parseQuickAdd('Emergency fix !urgent', projects)
      expect(result.title).toBe('Emergency fix')
      expect(result.priority).toBe('urgent')
    })

    it('reads the short forms', () => {
      expect(parseQuickAdd('Task !u', projects).priority).toBe('urgent')
      expect(parseQuickAdd('Task !h', projects).priority).toBe('high')
      expect(parseQuickAdd('Task !med', projects).priority).toBe('medium')
      expect(parseQuickAdd('Task !l', projects).priority).toBe('low')
    })

    it('is case-insensitive', () => {
      expect(parseQuickAdd('Task !HIGH', projects).priority).toBe('high')
    })

    it('takes the first run that names a priority', () => {
      const result = parseQuickAdd('Task !nope !low', projects)
      expect(result.priority).toBe('low')
      expect(result.title).toBe('Task !nope')
    })

    it('leaves an unknown keyword in the title', () => {
      const result = parseQuickAdd('Task !xyz', projects)
      expect(result.title).toBe('Task !xyz')
      expect(result.priority).toBe('none')
    })

    it('leaves prose punctuation alone', () => {
      // Nothing follows the marker, so these are sentences, not syntax.
      expect(parseQuickAdd('Ship it!', projects)).toMatchObject({
        title: 'Ship it!',
        priority: 'none'
      })
      expect(parseQuickAdd('Wow!!', projects)).toMatchObject({ title: 'Wow!!', priority: 'none' })
    })

    it('no longer reads the old double marker', () => {
      // `!` is the priority marker now; `!!high` is not a second spelling of it.
      const result = parseQuickAdd('Buy groceries !!high', projects)
      expect(result.title).toBe('Buy groceries !!high')
      expect(result.priority).toBe('none')
    })

    it('no longer reads a bare date keyword', () => {
      // `!today` used to mean "due today". `@` covers all of it now.
      const result = parseQuickAdd('Meeting !tomorrow', projects)
      expect(result.title).toBe('Meeting !tomorrow')
      expect(result.dueDate).toBeNull()
    })

    it('does not fire mid-word', () => {
      const result = parseQuickAdd('Deploy hotfix-1!high', projects)
      expect(result.title).toBe('Deploy hotfix-1!high')
      expect(result.priority).toBe('none')
    })
  })

  // --------------------------------------------------------------------------
  // + — project
  // --------------------------------------------------------------------------

  describe('project', () => {
    it("reads '+work' and takes it out of the title", () => {
      const result = parseQuickAdd('Review PR +work', projects)
      expect(result.title).toBe('Review PR')
      expect(result.projectId).toBe('work')
    })

    it('resolves a name as well as an id', () => {
      const result = parseQuickAdd('Buy groceries +Personal', projects)
      expect(result.title).toBe('Buy groceries')
      expect(result.projectId).toBe('personal')
    })

    it('leaves an unresolved project in the title', () => {
      const result = parseQuickAdd('Task +nonexistent', projects)
      expect(result.title).toBe('Task +nonexistent')
      expect(result.projectId).toBeNull()
    })

    it('never fires mid-word', () => {
      // The guards that make `+` safe in prose and in code.
      expect(parseQuickAdd('Compute 1+2 today', projects)).toMatchObject({
        title: 'Compute 1+2 today',
        projectId: null
      })
      expect(parseQuickAdd('Learn C++', projects)).toMatchObject({
        title: 'Learn C++',
        projectId: null
      })
    })

    it("no longer answers to the old '#' marker", () => {
      // Migration: `#Work` files a *tag* now, not the Work project.
      const result = parseQuickAdd('Review PR #Work', projects)
      expect(result.projectId).toBeNull()
      expect(result.tags).toEqual(['Work'])
    })
  })

  // --------------------------------------------------------------------------
  // # — tags
  // --------------------------------------------------------------------------

  describe('tags', () => {
    it('reads a tag and takes it out of the title', () => {
      const result = parseQuickAdd('Ship the beta #launch', projects)
      expect(result.title).toBe('Ship the beta')
      expect(result.tags).toEqual(['launch'])
    })

    it('reads every tag in the input, unlike the other markers', () => {
      const result = parseQuickAdd('Ship the beta #launch #q1 #marketing', projects)
      expect(result.title).toBe('Ship the beta')
      expect(result.tags).toEqual(['launch', 'q1', 'marketing'])
    })

    it('reads the note editor’s nested form', () => {
      const result = parseQuickAdd('Call the client #work/client', projects)
      expect(result.title).toBe('Call the client')
      expect(result.tags).toEqual(['work/client'])
    })

    it('keeps the case the user typed', () => {
      expect(parseQuickAdd('Read the paper #MIT', projects).tags).toEqual(['MIT'])
    })

    it('never fires mid-word', () => {
      expect(parseQuickAdd('Close issue#12', projects)).toMatchObject({
        title: 'Close issue#12',
        tags: []
      })
      expect(parseQuickAdd('Learn C# basics', projects)).toMatchObject({
        title: 'Learn C# basics',
        tags: []
      })
    })

    it('ignores a bare #', () => {
      const result = parseQuickAdd('Sort the # pile', projects)
      expect(result.title).toBe('Sort the # pile')
      expect(result.tags).toEqual([])
    })
  })

  // --------------------------------------------------------------------------
  // [[…]] — note links
  // --------------------------------------------------------------------------

  describe('note links', () => {
    it('reads the title inside the brackets and drops the run', () => {
      const result = parseQuickAdd('Draft the plan [[Roadmap]]', projects)
      expect(result.title).toBe('Draft the plan')
      expect(result.noteTitles).toEqual(['Roadmap'])
    })

    it('reads several links', () => {
      const result = parseQuickAdd('Prep [[Roadmap]] and [[Q1 Goals]]', projects)
      expect(result.title).toBe('Prep and')
      expect(result.noteTitles).toEqual(['Roadmap', 'Q1 Goals'])
    })

    it('leaves an unclosed run alone — it is still being typed', () => {
      const result = parseQuickAdd('Draft the plan [[Road', projects)
      expect(result.title).toBe('Draft the plan [[Road')
      expect(result.noteTitles).toEqual([])
    })

    it('treats a marker inside a link as part of the note title', () => {
      const result = parseQuickAdd('Prep [[Q3 #launch +work]] #real', projects)
      expect(result.noteTitles).toEqual(['Q3 #launch +work'])
      expect(result.tags).toEqual(['real'])
      expect(result.projectId).toBeNull()
      expect(result.title).toBe('Prep')
    })
  })

  // --------------------------------------------------------------------------
  // Everything together
  // --------------------------------------------------------------------------

  describe('combined syntax', () => {
    it('parses the whole grammar in one line', () => {
      const withMemry = [...projects, createMockProject({ id: 'memry', name: 'Memry' })]
      const result = parseQuickAdd(
        'Ship the beta @next friday !high +Memry #launch [[Roadmap]] every 2 weeks',
        withMemry
      )

      expect(result.title).toBe('Ship the beta')
      // From Saturday, "next friday" is next week's — the note editor's rule.
      expect(result.dueDate).toEqual(new Date(2026, 0, 23))
      expect(result.priority).toBe('high')
      expect(result.projectId).toBe('memry')
      expect(result.tags).toEqual(['launch'])
      expect(result.noteTitles).toEqual(['Roadmap'])
      expect(result.repeat).toMatchObject({ frequency: 'weekly', interval: 2 })
    })

    it('does not care about the order the markers are typed in', () => {
      const result = parseQuickAdd('+work Meeting @today !high #sync', projects)
      expect(result.title).toBe('Meeting')
      expect(result.dueDate).toEqual(new Date(2026, 0, 10))
      expect(result.priority).toBe('high')
      expect(result.projectId).toBe('work')
      expect(result.tags).toEqual(['sync'])
    })
  })

  describe('whitespace handling', () => {
    it('should clean extra whitespace', () => {
      const result = parseQuickAdd('  Buy   groceries  ', projects)
      expect(result.title).toBe('Buy groceries')
    })

    it('should clean whitespace after removing syntax', () => {
      const result = parseQuickAdd('Buy  @today   groceries', projects)
      expect(result.title).toBe('Buy groceries')
      expect(result.dueDate).toEqual(new Date(2026, 0, 10))
    })
  })
})

// ============================================================================
// T108: SPECIAL SYNTAX DETECTION
// ============================================================================

describe('hasSpecialSyntax', () => {
  it('detects each marker', () => {
    expect(hasSpecialSyntax('task !high')).toBe(true)
    expect(hasSpecialSyntax('task +work')).toBe(true)
    expect(hasSpecialSyntax('task #launch')).toBe(true)
    expect(hasSpecialSyntax('task [[Roadmap]]')).toBe(true)
    expect(hasSpecialSyntax('task @tomorrow')).toBe(true)
    expect(hasSpecialSyntax('task every monday')).toBe(true)
  })

  it('is false for plain prose', () => {
    expect(hasSpecialSyntax('plain task')).toBe(false)
    expect(hasSpecialSyntax('')).toBe(false)
    expect(hasSpecialSyntax('Check every door')).toBe(false)
  })

  it('is false for a lone marker', () => {
    expect(hasSpecialSyntax('task !')).toBe(false)
    expect(hasSpecialSyntax('task +')).toBe(false)
    expect(hasSpecialSyntax('task #')).toBe(false)
    expect(hasSpecialSyntax('task [[')).toBe(false)
  })

  it('does not carry state between calls', () => {
    // The marker patterns are global and module-level; scanning with `.test()`
    // would leave `lastIndex` behind and make every other call lie.
    expect(hasSpecialSyntax('task #launch')).toBe(true)
    expect(hasSpecialSyntax('task #launch')).toBe(true)
  })
})

// ============================================================================
// T109: PARSE PREVIEW
// ============================================================================

describe('getParsePreview', () => {
  const projects: Project[] = [
    createMockProject({ id: 'work', name: 'Work' }),
    createMockProject({ id: 'personal', name: 'Personal' })
  ]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 10))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should return all required fields', () => {
    const result = getParsePreview('task', projects)
    expect(result).toHaveProperty('hasDate')
    expect(result).toHaveProperty('hasPriority')
    expect(result).toHaveProperty('hasProject')
    expect(result).toHaveProperty('dueDate')
    expect(result).toHaveProperty('priority')
    expect(result).toHaveProperty('projectId')
    expect(result).toHaveProperty('projectName')
  })

  it('reports an empty input as carrying nothing', () => {
    const result = getParsePreview('task', projects)
    expect(result.hasDate).toBe(false)
    expect(result.hasPriority).toBe(false)
    expect(result.hasProject).toBe(false)
    expect(result.projectName).toBeNull()
  })

  it('reports every field the input carries', () => {
    const result = getParsePreview('task @tomorrow !urgent +personal', projects)
    expect(result.hasDate).toBe(true)
    expect(result.hasPriority).toBe(true)
    expect(result.hasProject).toBe(true)
    expect(result.dueDate).toEqual(new Date(2026, 0, 11))
    expect(result.priority).toBe('urgent')
    expect(result.projectId).toBe('personal')
    expect(result.projectName).toBe('Personal')
  })

  it('reports an unresolved project as no project', () => {
    const result = getParsePreview('task +nonexistent', projects)
    expect(result.hasProject).toBe(false)
    expect(result.projectId).toBeNull()
    expect(result.projectName).toBeNull()
  })
})

// ============================================================================
// T110: AUTOCOMPLETE OPTIONS
// ============================================================================

describe('getPriorityOptions', () => {
  it('offers the four priorities, single-marker only', () => {
    const result = getPriorityOptions('')
    expect(result).toHaveLength(4)
    expect(result.map((o) => o.value)).toEqual(['!urgent', '!high', '!medium', '!low'])
  })

  it('filters by what has been typed', () => {
    expect(getPriorityOptions('h').map((o) => o.value)).toContain('!high')
    expect(getPriorityOptions('ur')).toHaveLength(1)
    expect(getPriorityOptions('med')[0].value).toBe('!medium')
  })
})

describe('getProjectOptions', () => {
  const projects: Project[] = [
    createMockProject({ id: 'work', name: 'Work' }),
    createMockProject({ id: 'personal', name: 'Personal' }),
    createMockProject({ id: 'archived', name: 'Archived', isArchived: true }),
    createMockProject({ id: 'dev', name: 'Development' })
  ]

  it('offers every active project', () => {
    const result = getProjectOptions('', projects)
    expect(result).toHaveLength(3)
    expect(result.map((o) => o.label)).toEqual(['Work', 'Personal', 'Development'])
  })

  it('excludes archived projects', () => {
    expect(getProjectOptions('', projects).map((o) => o.label)).not.toContain('Archived')
  })

  it('filters by name and by id', () => {
    expect(getProjectOptions('dev', projects)[0].label).toBe('Development')
    expect(getProjectOptions('personal', projects)[0].label).toBe('Personal')
    expect(getProjectOptions('xyz', projects)).toHaveLength(0)
  })

  it("writes the value with the '+' marker", () => {
    const result = getProjectOptions('', projects)
    expect(result[0].value).toBe('+Work')
    expect(result[1].value).toBe('+Personal')
  })
})

describe('getTagOptions', () => {
  const tags = ['launch', 'work/client', 'MIT']

  it('offers the whole pool in the order it was given', () => {
    const result = getTagOptions('', tags)
    expect(result.map((o) => o.value)).toEqual(['#launch', '#work/client', '#MIT'])
  })

  it('filters case-insensitively', () => {
    expect(getTagOptions('mit', tags).map((o) => o.value)).toEqual(['#MIT'])
    expect(getTagOptions('client', tags).map((o) => o.value)).toEqual(['#work/client'])
    expect(getTagOptions('zzz', tags)).toHaveLength(0)
  })
})

// ============================================================================
// NATURAL-LANGUAGE DATE PHRASES AND REPEATS (#129)
// ============================================================================

describe('natural-language quick-add', () => {
  const projects: Project[] = [createMockProject({ id: 'work', name: 'Work' })]

  beforeEach(() => {
    // Saturday, 10 January 2026.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 10))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('findDatePhrase', () => {
    it('reads a single-word mention', () => {
      const match = findDatePhrase('Call Bob @tomorrow')
      expect(match).toMatchObject({ start: 9, end: 18, text: '@tomorrow' })
      expect(match?.date).toEqual(new Date(2026, 0, 11))
    })

    it('reads a multi-word mention and stops at the title', () => {
      const match = findDatePhrase('@next wednesday call Bob')
      expect(match?.text).toBe('@next wednesday')
      // From Saturday, "next wednesday" is next week's — the same rule the note
      // editor's @-mentions follow.
      expect(match?.date).toEqual(new Date(2026, 0, 21))
    })

    it('reads a time when the phrase carries one', () => {
      const match = findDatePhrase('Standup @tomorrow at 9:30')
      expect(match?.text).toBe('@tomorrow at 9:30')
      expect(match?.time).toBe('09:30')
    })

    it('ignores a mention that is not a date', () => {
      expect(findDatePhrase('Ping @bob about the deck')).toBeNull()
    })

    it('ignores an @ inside a word', () => {
      expect(findDatePhrase('mail bob@today.com')).toBeNull()
    })
  })

  describe('findNoteLinks', () => {
    it('reads every finished run and where it sits', () => {
      expect(findNoteLinks('Prep [[Roadmap]] then [[Q1 Goals]]')).toEqual([
        { start: 5, end: 16, title: 'Roadmap' },
        { start: 22, end: 34, title: 'Q1 Goals' }
      ])
    })

    it('reads nothing from an unfinished run', () => {
      expect(findNoteLinks('Prep [[Road')).toEqual([])
    })
  })

  describe('parseQuickAdd — date phrases', () => {
    it('pulls the phrase out of the title', () => {
      const result = parseQuickAdd('Call Bob @next wednesday', projects)
      expect(result.title).toBe('Call Bob')
      expect(result.dueDate).toEqual(new Date(2026, 0, 21))
      expect(result.dueTime).toBeNull()
    })

    it('keeps the time from the phrase', () => {
      const result = parseQuickAdd('Standup @tomorrow at 9:30', projects)
      expect(result.title).toBe('Standup')
      expect(result.dueTime).toBe('09:30')
    })

    it('combines with priority and project', () => {
      const result = parseQuickAdd('Ship it @tomorrow !high +Work', projects)
      expect(result.title).toBe('Ship it')
      expect(result.dueDate).toEqual(new Date(2026, 0, 11))
      expect(result.priority).toBe('high')
      expect(result.projectId).toBe('work')
    })

    it('leaves an unparseable mention in the title', () => {
      const result = parseQuickAdd('Ping @bob', projects)
      expect(result.title).toBe('Ping @bob')
      expect(result.dueDate).toBeNull()
    })

    it('takes only the first phrase that reads as a date', () => {
      const result = parseQuickAdd('Call Bob @tomorrow @friday', projects)
      expect(result.dueDate).toEqual(new Date(2026, 0, 11))
      expect(result.title).toBe('Call Bob @friday')
    })
  })

  describe('parseQuickAdd — repeats', () => {
    it('parses "every monday" and starts on the next Monday', () => {
      const result = parseQuickAdd('Team sync every monday', projects)
      expect(result.title).toBe('Team sync')
      expect(result.repeat).toMatchObject({ frequency: 'weekly', daysOfWeek: [1] })
      expect(result.dueDate).toEqual(new Date(2026, 0, 12))
    })

    it('parses "every 2 weeks" and starts today', () => {
      const result = parseQuickAdd('Water plants every 2 weeks', projects)
      expect(result.title).toBe('Water plants')
      expect(result.repeat).toMatchObject({ frequency: 'weekly', interval: 2 })
      expect(result.dueDate).toEqual(new Date(2026, 0, 10))
    })

    it('parses "every weekday" and starts on the next weekday', () => {
      const result = parseQuickAdd('Standup every weekday', projects)
      expect(result.repeat).toMatchObject({ daysOfWeek: [1, 2, 3, 4, 5] })
      expect(result.dueDate).toEqual(new Date(2026, 0, 12))
    })

    it('anchors "every month" to an explicit due date', () => {
      const result = parseQuickAdd('Pay rent @jan 31 every month', projects)
      expect(result.title).toBe('Pay rent')
      expect(result.dueDate).toEqual(new Date(2026, 0, 31))
      expect(result.repeat).toMatchObject({ monthlyType: 'dayOfMonth', dayOfMonth: 31 })
    })

    it('keeps a due date the user typed', () => {
      const result = parseQuickAdd('Report @friday every week', projects)
      expect(result.dueDate).toEqual(new Date(2026, 0, 16))
      expect(result.repeat).toMatchObject({ frequency: 'weekly', interval: 1 })
    })

    it('leaves a plain "every" in the title', () => {
      const result = parseQuickAdd('Check every door', projects)
      expect(result.title).toBe('Check every door')
      expect(result.repeat).toBeNull()
      expect(result.dueDate).toBeNull()
    })
  })

  describe('findQuickAddSpans', () => {
    it('marks every syntax stretch, phrases included', () => {
      expect(
        findQuickAddSpans('Sync [[Roadmap]] @tomorrow every monday !high +Work #launch')
      ).toEqual([
        { start: 5, end: 16, kind: 'noteLink' },
        { start: 17, end: 26, kind: 'datePhrase' },
        { start: 27, end: 39, kind: 'repeat' },
        { start: 40, end: 45, kind: 'priority' },
        { start: 46, end: 51, kind: 'project' },
        { start: 52, end: 59, kind: 'tag' }
      ])
    })

    it('marks nothing in plain prose', () => {
      expect(findQuickAddSpans('Buy groceries every door')).toEqual([])
    })

    it('marks a half-typed marker, so the pill appears as it is typed', () => {
      expect(findQuickAddSpans('Task !hi')).toEqual([{ start: 5, end: 8, kind: 'priority' }])
      expect(findQuickAddSpans('Task +foo')).toEqual([{ start: 5, end: 9, kind: 'project' }])
    })

    it('does not mark a marker that lives inside a note link', () => {
      expect(findQuickAddSpans('Prep [[Q3 #launch]]')).toEqual([
        { start: 5, end: 19, kind: 'noteLink' }
      ])
    })

    it('agrees with what the parser strips', () => {
      // Landmine: pills and title-stripping must not disagree, or the caret and
      // the captured title stop matching what the user sees.
      const input = 'Sync [[Roadmap]] @tomorrow every monday !high +Work #launch'
      const spans = findQuickAddSpans(input)
      const remainder = spans
        .reduceRight((text, span) => text.slice(0, span.start) + text.slice(span.end), input)
        .replace(/\s+/g, ' ')
        .trim()

      expect(remainder).toBe(
        parseQuickAdd(input, [createMockProject({ id: 'work', name: 'Work' })]).title
      )
    })
  })

  describe('hasSpecialSyntax', () => {
    it('is true for natural-language phrases', () => {
      expect(hasSpecialSyntax('Call Bob @tomorrow')).toBe(true)
      expect(hasSpecialSyntax('Water plants every 2 weeks')).toBe(true)
    })

    it('is false for plain prose', () => {
      expect(hasSpecialSyntax('Check every door')).toBe(false)
    })
  })

  describe('predictRepeatCompletion', () => {
    it('completes a cadence from what has been typed', () => {
      expect(predictRepeatCompletion('every w')).toBe('every weekday')
      expect(predictRepeatCompletion('every 2')).toBe('every 2 weeks')
      expect(predictRepeatCompletion('every')).toBe('every day')
    })

    it('completes nothing once the phrase cannot become a cadence', () => {
      expect(predictRepeatCompletion('every door')).toBeNull()
      expect(predictRepeatCompletion('never')).toBeNull()
    })
  })
})
