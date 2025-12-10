/**
 * useNotes Hook
 * Manages notes data for journal functionality
 */

import { useState, useCallback, useEffect } from 'react'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { getTodayString } from '@/lib/journal-utils'

export interface Note {
  id: string
  title: string
  content: string
  createdAt: string // ISO timestamp
  updatedAt: string
  folderPath?: string
  preview?: string // First ~60 chars
}

const STORAGE_KEY = 'memry:notes'

// Mock data for initial development
const MOCK_NOTES: Note[] = [
  {
    id: '1',
    title: 'Meeting Notes - Design Review',
    content: '<p>Discussed the new dashboard designs with the team. Great feedback from Sarah about the navigation flow.</p><p>Action items: Update prototype, schedule follow-up.</p>',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago (today)
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    preview: 'Discussed the new dashboard designs with the team. Great feedback from Sarah...',
  },
  {
    id: '2',
    title: 'Quick Ideas',
    content: '<p>Brainstorming session notes:</p><ul><li>Add dark mode toggle</li><li>Improve search performance</li><li>Better mobile navigation</li></ul>',
    createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours ago (today)
    updatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    preview: 'Brainstorming session notes: Add dark mode toggle, Improve search...',
  },
  {
    id: '3',
    title: 'Sprint Planning Notes',
    content: '<p>Q1 sprint planning discussion. Team capacity looks good for the upcoming features.</p><p>Priorities: Performance improvements, new onboarding flow.</p>',
    createdAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(), // 8 hours ago (today)
    updatedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    preview: 'Q1 sprint planning discussion. Team capacity looks good...',
  },
  {
    id: '4',
    title: 'Book Notes - Deep Work',
    content: '<p>Key takeaways from Cal Newport\'s Deep Work:</p><ul><li>Schedule deep work blocks</li><li>Minimize shallow work</li><li>Embrace boredom</li></ul>',
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    preview: "Key takeaways from Cal Newport's Deep Work: Schedule deep work blocks...",
  },
  {
    id: '5',
    title: 'Weekly Review',
    content: '<p>What went well this week:</p><ul><li>Shipped new feature</li><li>Great team collaboration</li><li>Good progress on roadmap</li></ul>',
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    preview: 'What went well this week: Shipped new feature, Great team collaboration...',
  },
  {
    id: '6',
    title: 'Project Alpha Ideas',
    content: '<p>Initial thoughts for Project Alpha:</p><ul><li>User research needed</li><li>Competitive analysis</li><li>Technical feasibility study</li></ul>',
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days ago
    updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    preview: 'Initial thoughts for Project Alpha: User research needed...',
  },
]

/**
 * Custom hook for managing notes
 */
export function useNotes() {
  const [notes, setNotes] = useState<Note[]>(() => {
    // Try to load from localStorage, fall back to mock data
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        return JSON.parse(stored)
      }
    } catch (error) {
      console.error('Failed to load notes from localStorage:', error)
    }
    return MOCK_NOTES
  })

  // Persist to localStorage whenever notes change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes))
    } catch (error) {
      console.error('Failed to save notes to localStorage:', error)
    }
  }, [notes])

  /**
   * Get a note by ID
   */
  const getNote = useCallback(
    (id: string): Note | undefined => {
      return notes.find((n) => n.id === id)
    },
    [notes]
  )

  /**
   * Create a new note
   */
  const createNote = useCallback(
    (title: string, content: string = ''): Note => {
      const now = new Date().toISOString()
      const newNote: Note = {
        id: crypto.randomUUID(),
        title: title.trim(),
        content,
        createdAt: now,
        updatedAt: now,
        preview: content ? content.substring(0, 60).replace(/<[^>]*>/g, '') + '...' : undefined,
      }

      setNotes((prev) => [newNote, ...prev])
      return newNote
    },
    []
  )

  /**
   * Update an existing note
   */
  const updateNote = useCallback((id: string, updates: Partial<Omit<Note, 'id'>>) => {
    setNotes((prev) =>
      prev.map((note) =>
        note.id === id
          ? {
              ...note,
              ...updates,
              updatedAt: new Date().toISOString(),
            }
          : note
      )
    )
  }, [])

  /**
   * Delete a note
   */
  const deleteNote = useCallback((id: string) => {
    setNotes((prev) => prev.filter((note) => note.id !== id))
  }, [])

  /**
   * Get notes for a specific date (YYYY-MM-DD format)
   */
  const getNotesByDate = useCallback(
    (date: string): Note[] => {
      return notes.filter((note) => {
        const noteDate = note.createdAt.substring(0, 10) // Extract YYYY-MM-DD
        return noteDate === date
      })
    },
    [notes]
  )

  /**
   * Get today's notes (sorted by creation time, newest first)
   */
  const getTodaysNotes = useCallback((): Note[] => {
    const today = getTodayString()
    return getNotesByDate(today).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }, [getNotesByDate])

  /**
   * Search notes with fuzzy matching
   */
  const searchNotes = useCallback(
    (query: string): Note[] => {
      if (!query || query.trim() === '') {
        // Return all notes sorted by most recently updated
        return [...notes].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )
      }

      return fuzzySearch(notes, query, ['title', 'content', 'preview'])
    },
    [notes]
  )

  /**
   * Get recent notes (sorted by last updated)
   */
  const getRecentNotes = useCallback(
    (limit: number = 5): Note[] => {
      return [...notes]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, limit)
    },
    [notes]
  )

  return {
    notes,
    getNote,
    createNote,
    updateNote,
    deleteNote,
    getNotesByDate,
    getTodaysNotes,
    searchNotes,
    getRecentNotes,
  }
}
