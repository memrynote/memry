/**
 * Project fixtures for testing.
 */

export interface ProjectFixture {
  id: string
  name: string
  description: string | null
  color: string
  icon: string | null
  position: number
  isInbox: boolean
  archivedAt: string | null
  createdAt: string
  modifiedAt: string
}

export const sampleProjects: ProjectFixture[] = [
  {
    id: 'inbox',
    name: 'Inbox',
    description: 'Default inbox for uncategorized tasks',
    color: '#6b7280',
    icon: '📥',
    position: 0,
    isInbox: true,
    archivedAt: null,
    createdAt: '2025-01-01T00:00:00Z',
    modifiedAt: '2025-01-01T00:00:00Z'
  },
  {
    id: 'project-1',
    name: 'Work',
    description: 'Work-related tasks',
    color: '#3b82f6',
    icon: '💼',
    position: 1,
    isInbox: false,
    archivedAt: null,
    createdAt: '2025-01-01T00:00:00Z',
    modifiedAt: '2025-01-01T00:00:00Z'
  },
  {
    id: 'project-2',
    name: 'Personal',
    description: 'Personal tasks and goals',
    color: '#10b981',
    icon: '🏠',
    position: 2,
    isInbox: false,
    archivedAt: null,
    createdAt: '2025-01-01T00:00:00Z',
    modifiedAt: '2025-01-01T00:00:00Z'
  }
]

export function createProjectFixture(overrides: Partial<ProjectFixture> = {}): ProjectFixture {
  return {
    id: overrides.id || `project-${Date.now()}`,
    name: overrides.name || 'Test Project',
    description: overrides.description ?? null,
    color: overrides.color || '#6366f1',
    icon: overrides.icon ?? null,
    position: overrides.position ?? 0,
    isInbox: overrides.isInbox ?? false,
    archivedAt: overrides.archivedAt ?? null,
    createdAt: overrides.createdAt || new Date().toISOString(),
    modifiedAt: overrides.modifiedAt || new Date().toISOString()
  }
}
