export type SearchScope = 'all' | 'note' | 'task' | 'journal'

export interface NoteHit {
  kind: 'note'
  id: string
  title: string
  folderPath: string | null
  updatedAt: number
}

export interface TaskHit {
  kind: 'task'
  id: string
  title: string
  dueDate: string | null // 'YYYY-MM-DD', verbatim from the payload
  completedAt: string | null
  projectName: string | null
}

export interface JournalHit {
  kind: 'journal'
  id: string
  date: string // 'YYYY-MM-DD'
  snippet: string | null
  updatedAt: number
}

// The union is discriminated on purpose. A task hit cannot carry a `folderPath`
// and a note hit cannot carry a due date, so no renderer can read a field its
// row never had. Do not flatten it.
export type SearchHit = NoteHit | TaskHit | JournalHit

export interface SearchRepo {
  search(query: string): Promise<SearchHit[]>
  countMatches(query: string): Promise<number>
}

export interface RecentSearchStore {
  list(): Promise<string[]>
  record(query: string): Promise<void>
  clear(): Promise<void>
}

export type JumpTargetKind = 'todays-journal' | 'inbox' | 'overdue-tasks'

export interface JumpTarget {
  kind: JumpTargetKind
  title: string
  subtitle: string
  count: number // 0 for todays-journal; drives the accessibility label
}
