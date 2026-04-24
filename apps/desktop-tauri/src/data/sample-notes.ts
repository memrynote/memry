// ============================================================================
// SAMPLE NOTES DATA
// Placeholder data for the note linking feature in Task Detail Panel
// ============================================================================

export interface Note {
  id: string
  title: string
  type: 'note' | 'document' | 'meeting'
  createdAt: Date
}

export const sampleNotes: Note[] = [
  {
    id: 'note-1',
    title: 'Q4 Planning Document',
    type: 'document',
    createdAt: new Date('2024-11-15')
  },
  {
    id: 'note-2',
    title: 'Design System Architecture',
    type: 'document',
    createdAt: new Date('2024-10-20')
  },
  {
    id: 'note-3',
    title: 'Meeting Notes - Dec 10',
    type: 'meeting',
    createdAt: new Date('2024-12-10')
  },
  {
    id: 'note-4',
    title: 'API Documentation',
    type: 'document',
    createdAt: new Date('2024-11-01')
  },
  {
    id: 'note-5',
    title: 'User Research Findings',
    type: 'note',
    createdAt: new Date('2024-11-25')
  },
  {
    id: 'note-6',
    title: 'Sprint Retrospective',
    type: 'meeting',
    createdAt: new Date('2024-12-05')
  },
  {
    id: 'note-7',
    title: 'Product Roadmap 2025',
    type: 'document',
    createdAt: new Date('2024-12-01')
  },
  {
    id: 'note-8',
    title: 'Technical Debt Analysis',
    type: 'note',
    createdAt: new Date('2024-11-10')
  },
  {
    id: 'note-9',
    title: 'Onboarding Flow Ideas',
    type: 'note',
    createdAt: new Date('2024-12-08')
  },
  {
    id: 'note-10',
    title: 'Weekly Sync - Week 49',
    type: 'meeting',
    createdAt: new Date('2024-12-09')
  }
]

/**
 * Get note by ID
 */
export const getNoteById = (id: string): Note | undefined => {
  return sampleNotes.find((note) => note.id === id)
}

/**
 * Search notes by title (case-insensitive)
 */
export const searchNotes = (query: string): Note[] => {
  if (!query.trim()) return sampleNotes
  const lowerQuery = query.toLowerCase()
  return sampleNotes.filter((note) => note.title.toLowerCase().includes(lowerQuery))
}
