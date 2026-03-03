/**
 * Note fixtures for testing.
 */

export interface NoteFixture {
  id: string
  title: string
  path: string
  folder: string
  content: string
  tags: string[]
  emoji?: string
  createdAt: string
  modifiedAt: string
}

export const sampleNotes: NoteFixture[] = [
  {
    id: 'note-1',
    title: 'Getting Started',
    path: 'notes/Getting Started.md',
    folder: 'notes',
    content: '# Getting Started\n\nWelcome to Memry!',
    tags: ['welcome', 'tutorial'],
    emoji: '👋',
    createdAt: '2025-01-01T00:00:00Z',
    modifiedAt: '2025-01-01T00:00:00Z'
  },
  {
    id: 'note-2',
    title: 'Project Ideas',
    path: 'notes/projects/Project Ideas.md',
    folder: 'notes/projects',
    content: '# Project Ideas\n\n- Build a PKM app\n- Learn TypeScript',
    tags: ['ideas', 'projects'],
    createdAt: '2025-01-02T00:00:00Z',
    modifiedAt: '2025-01-02T00:00:00Z'
  },
  {
    id: 'note-3',
    title: 'Daily Notes Template',
    path: 'notes/templates/Daily Notes Template.md',
    folder: 'notes/templates',
    content: '# {{date}}\n\n## Tasks\n\n## Notes\n\n## Reflections',
    tags: ['template'],
    createdAt: '2025-01-03T00:00:00Z',
    modifiedAt: '2025-01-03T00:00:00Z'
  }
]

export function createNoteFixture(overrides: Partial<NoteFixture> = {}): NoteFixture {
  const id = overrides.id || `note-${Date.now()}`
  const title = overrides.title || 'Test Note'

  return {
    id,
    title,
    path: overrides.path || `notes/${title}.md`,
    folder: overrides.folder || 'notes',
    content: overrides.content || `# ${title}\n\nTest content.`,
    tags: overrides.tags || [],
    emoji: overrides.emoji,
    createdAt: overrides.createdAt || new Date().toISOString(),
    modifiedAt: overrides.modifiedAt || new Date().toISOString()
  }
}
