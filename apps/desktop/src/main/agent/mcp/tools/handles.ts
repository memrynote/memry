// Dependency-injected facade: every tool calls into here, never directly into stores.
// Tests pass a fake; production wiring constructs from real services in lifecycle.ts.

import type {
  AgentMcpDesktopReadOperation,
  AgentMcpDesktopWriteOperation
} from '@memry/contracts/agent-mcp-channels'

export interface NoteSummary {
  id: string
  title: string
  snippet: string
  folder_path: string | null
  icon?: string | null
}

export interface NoteFull {
  id: string
  title: string
  content_markdown: string
  tags: string[]
  folder_path: string | null
  frontmatter: Record<string, unknown>
  icon?: string | null
}

export interface FolderEntry {
  kind: 'folder' | 'note'
  id: string
  name: string
  path: string
  icon?: string | null
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
  type?: string
  visual_type?: string
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

export type CanvasEntityKind = 'note' | 'task' | 'calendar_event'

/**
 * One entity sitting on a canvas. `missing` marks a card whose entity no longer
 * exists — reported rather than dropped, so an agent can surface a stale card
 * instead of silently under-reporting what is on the canvas.
 */
export interface CanvasItemSummary {
  entity_type: CanvasEntityKind
  entity_id: string
  title: string | null
  missing: boolean
}

export interface CanvasListEntry {
  id: string
  title: string | null
  updated_at: number
  item_count: number
}

/** A canvas as an agent sees it: what is ON it, never the geometry that draws it. */
export interface CanvasDetail {
  id: string
  title: string | null
  created_at: number
  updated_at: number
  items: CanvasItemSummary[]
  texts: string[]
  element_count: number
  texts_truncated: boolean
}

export interface CanvasWriteOutcome {
  canvas_id: string
  applied: { entity_type: string; entity_id: string }[]
  skipped: { entity_type: string; entity_id: string; reason: string }[]
  updated_at: number
  /** Saved locally but too large to sync (canvas spec §5.6). */
  too_large: boolean
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
    rename(input: { id: string; title: string }): Promise<{ id: string }>
    delete(id: string): Promise<{ id: string }>
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
    create(path: string): Promise<{ path: string }>
    rename(input: { old_path: string; new_path: string }): Promise<{ path: string }>
    delete(path: string): Promise<{ path: string }>
  }
  tasks: {
    list(input: {
      status?: string
      project_id?: string | null
      due_before?: string
      tag?: string
      limit?: number
    }): Promise<TaskSummary[]>
    get(id: string): Promise<unknown>
    create(input: {
      title: string
      project_id?: string | null
      status_id?: string | null
      parent_id?: string | null
      due?: string | null
      due_date?: string | null
      due_time?: string | null
      start_date?: string | null
      priority?: number
      tags?: string[]
      notes?: string | null
      description?: string | null
      is_repeating?: boolean
      repeat_config?: Record<string, unknown> | null
      repeat_from?: 'due' | 'completion' | null
      linked_note_ids?: string[]
      source_note_id?: string | null
      position?: number
    }): Promise<{ id: string }>
    update(
      id: string,
      patch: {
        title?: string
        status?: string
        status_id?: string | null
        project_id?: string | null
        parent_id?: string | null
        due?: string | null
        due_date?: string | null
        due_time?: string | null
        start_date?: string | null
        priority?: number
        notes?: string | null
        description?: string | null
        is_repeating?: boolean
        repeat_config?: Record<string, unknown> | null
        repeat_from?: 'due' | 'completion' | null
        tags?: string[]
        linked_note_ids?: string[]
      }
    ): Promise<void>
    delete(id: string): Promise<{ id: string }>
    complete(input: { id: string; completed_at?: string }): Promise<{ id: string }>
    uncomplete(id: string): Promise<{ id: string }>
    archive(id: string): Promise<{ id: string }>
    unarchive(id: string): Promise<{ id: string }>
    move(input: {
      task_id: string
      target_project_id?: string
      target_status_id?: string | null
      target_parent_id?: string | null
      position: number
    }): Promise<{ id: string }>
    reorder(input: { task_ids: string[]; positions: number[] }): Promise<{ ids: string[] }>
    duplicate(id: string): Promise<{ id: string }>
    convertToSubtask(input: { task_id: string; parent_id: string }): Promise<{ id: string }>
    convertToTask(id: string): Promise<{ id: string }>
    addTag(input: { id: string; tag: string }): Promise<void>
    removeTag(input: { id: string; tag: string }): Promise<void>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    get(id: string): Promise<unknown>
    create(input: {
      name: string
      description?: string | null
      color?: string
      icon?: string | null
      statuses?: Array<{
        id?: string
        name: string
        color: string
        type: 'todo' | 'in_progress' | 'done'
        order: number
      }>
    }): Promise<{ id: string }>
    update(input: {
      id: string
      name?: string
      description?: string | null
      color?: string
      icon?: string | null
      statuses?: Array<{
        id?: string
        name: string
        color: string
        type: 'todo' | 'in_progress' | 'done'
        order: number
      }>
    }): Promise<{ id: string }>
    delete(id: string): Promise<{ id: string }>
    archive(id: string): Promise<{ id: string }>
    reorder(input: { project_ids: string[]; positions: number[] }): Promise<{ ids: string[] }>
  }
  statuses: {
    list(projectId: string): Promise<unknown[]>
    create(input: {
      project_id: string
      name: string
      color?: string
      is_done?: boolean
    }): Promise<{ id: string }>
    update(input: {
      id: string
      name?: string
      color?: string
      position?: number
      is_default?: boolean
      is_done?: boolean
    }): Promise<{ id: string }>
    delete(id: string): Promise<{ id: string }>
    reorder(input: { status_ids: string[]; positions: number[] }): Promise<{ ids: string[] }>
  }
  journal: {
    getByDate(date: string): Promise<JournalEntry | null>
    listInRange(input: { from: string; to: string }): Promise<JournalSummary[]>
    createIfMissing(input: {
      date: string
      content_markdown: string
    }): Promise<{ id: string; created: boolean }>
    update(input: {
      date: string
      content_markdown?: string
      tags?: string[]
      properties?: Record<string, unknown>
    }): Promise<{ id: string }>
    delete(date: string): Promise<{ date: string; deleted: boolean }>
  }
  inbox: {
    list(input: { unread_only?: boolean }): Promise<InboxSummary[]>
    get(id: string): Promise<unknown>
    add(input: { source: string; title: string; content: string }): Promise<{ id: string }>
    update(input: { id: string; title?: string; content?: string }): Promise<{ id: string }>
    snooze(input: { id: string; snooze_until: string; reason?: string }): Promise<{ id: string }>
    archive(id: string): Promise<{ id: string }>
    unarchive(id: string): Promise<{ id: string }>
    delete(id: string): Promise<{ id: string }>
    addTag(input: { id: string; tag: string }): Promise<{ id: string }>
    removeTag(input: { id: string; tag: string }): Promise<{ id: string }>
  }
  tags: {
    listAll(): Promise<TagCount[]>
  }
  canvas: {
    list(): Promise<CanvasListEntry[]>
    read(id: string): Promise<CanvasDetail | null>
    addItems(
      input: { canvasId: string; items: { entityType: CanvasEntityKind; entityId: string }[] },
      windowId: string | null
    ): Promise<CanvasWriteOutcome>
    removeItem(
      input: { canvasId: string; item: { entityType: CanvasEntityKind; entityId: string } },
      windowId: string | null
    ): Promise<CanvasWriteOutcome>
  }
  desktop: {
    read(
      input: { operation: AgentMcpDesktopReadOperation; args: unknown[] },
      windowId: string | null
    ): Promise<unknown>
    write(
      input: { operation: AgentMcpDesktopWriteOperation; args: unknown[] },
      windowId: string | null
    ): Promise<unknown>
  }
  windows: {
    snapshotCurrentNote(windowId: string): Promise<CurrentNoteSnapshot | null>
  }
}
