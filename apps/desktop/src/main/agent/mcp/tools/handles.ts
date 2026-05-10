// Dependency-injected facade: every tool calls into here, never directly into stores.
// Tests pass a fake; production wiring constructs from real services in lifecycle.ts.

export interface NoteSummary {
  id: string
  title: string
  snippet: string
  folder_path: string | null
}

export interface NoteFull {
  id: string
  title: string
  content_markdown: string
  tags: string[]
  folder_path: string | null
  frontmatter: Record<string, unknown>
}

export interface FolderEntry {
  kind: 'folder' | 'note'
  id: string
  name: string
  path: string
}

export interface TaskSummary {
  id: string
  title: string
  status: string
  due: string | null
  project: string | null
  tags: string[]
}

export interface ProjectSummary {
  id: string
  name: string
  status: string | null
  task_count: number
}

export interface JournalEntry {
  id: string
  date: string
  content_markdown: string
}

export interface JournalSummary {
  id: string
  date: string
  title: string
}

export interface InboxSummary {
  id: string
  source: string
  title: string
  snippet: string
  captured_at: number
}

export interface TagCount {
  name: string
  count: number
}

export interface CurrentNoteSnapshot {
  id: string
  title: string
  content_markdown: string
  tags: string[]
}

export interface VaultServiceHandles {
  notes: {
    search(input: { query: string; limit?: number; folderId?: string }): Promise<NoteSummary[]>
    read(id: string): Promise<NoteFull | null>
    create(input: {
      title: string
      content_markdown: string
      folder_path?: string
      tags?: string[]
    }): Promise<{ id: string }>
    update(input: {
      id: string
      mode: 'append' | 'prepend' | 'replace'
      content_markdown: string
    }): Promise<void>
    addTag(input: { id: string; tag: string }): Promise<void>
    removeTag(input: { id: string; tag: string }): Promise<void>
    moveToFolder(input: { id: string; folder_path: string }): Promise<void>
  }
  folders: {
    list(input: { path?: string; id?: string; recursive?: boolean }): Promise<FolderEntry[]>
  }
  tasks: {
    list(input: {
      status?: string
      project_id?: string
      due_before?: string
      tag?: string
      limit?: number
    }): Promise<TaskSummary[]>
    create(input: {
      title: string
      project_id?: string
      due?: string
      priority?: number
      tags?: string[]
      notes?: string
    }): Promise<{ id: string }>
    update(
      id: string,
      patch: {
        title?: string
        status?: string
        project_id?: string | null
        due?: string | null
        priority?: number
        notes?: string
      }
    ): Promise<void>
    addTag(input: { id: string; tag: string }): Promise<void>
    removeTag(input: { id: string; tag: string }): Promise<void>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
  }
  journal: {
    getByDate(date: string): Promise<JournalEntry | null>
    listInRange(input: { from: string; to: string }): Promise<JournalSummary[]>
    createIfMissing(input: {
      date: string
      content_markdown: string
    }): Promise<{ id: string; created: boolean }>
  }
  inbox: {
    list(input: { unread_only?: boolean }): Promise<InboxSummary[]>
    add(input: { source: string; title: string; content: string }): Promise<{ id: string }>
  }
  tags: {
    listAll(): Promise<TagCount[]>
  }
  windows: {
    snapshotCurrentNote(windowId: string): Promise<CurrentNoteSnapshot | null>
  }
}
