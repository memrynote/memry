import type { Project } from '@/data/tasks-data'

interface SelectedProjectContext {
  selectedType: string
  selectedProject: Project | null
}

export function resolveModalDefaultProject(
  context: SelectedProjectContext,
  defaultProjectId: string | null,
  filteredProjectId?: string | null
): string {
  if (context.selectedType === 'project' && context.selectedProject) {
    return context.selectedProject.id
  }
  if (filteredProjectId) {
    return filteredProjectId
  }
  if (defaultProjectId) {
    return defaultProjectId
  }
  return 'personal'
}

export function resolveInitialViewProject(
  selectedType: string,
  defaultProjectId: string | null,
  projects: Project[]
): string | null {
  if (selectedType === 'project') {
    return null
  }
  if (defaultProjectId && projects.some((p) => p.id === defaultProjectId && !p.isArchived)) {
    return defaultProjectId
  }
  return null
}

export function resolveQuickAddProject(
  parsedProjectId: string | null | undefined,
  context: SelectedProjectContext,
  defaultProjectId: string | null,
  projects: Project[],
  filteredProjectId?: string | null
): string {
  if (parsedProjectId) {
    return parsedProjectId
  }

  if (context.selectedType === 'project' && context.selectedProject) {
    return context.selectedProject.id
  }

  if (filteredProjectId) {
    return filteredProjectId
  }

  if (defaultProjectId) {
    return defaultProjectId
  }

  const personalProject = projects.find((p) => p.isDefault)
  if (personalProject) {
    return personalProject.id
  }

  return 'personal'
}
