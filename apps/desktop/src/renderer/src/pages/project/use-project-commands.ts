import type { CommandIdsOf } from '@memry/contracts/commands'
import { useT } from '@memry/i18n/renderer'
import { useTabCommands, type CommandImpl } from '@/commands'

export type ProjectCommandId = CommandIdsOf<'project'>

interface ProjectCommandInput {
  /** False while the id resolves to no project: the page then shows its empty state. */
  hasProject: boolean
  /** False for the inbox project, which the data layer refuses to archive. */
  canArchive: boolean
  openEditor: () => void
  archive: () => Promise<void>
  focusCapture: () => void
  addNote: () => Promise<void>
  openFilePicker: () => void
  addEvent: () => void
}

/**
 * The owner of every `project.*` command, registered per tab. Each command runs
 * the same callback the page's header menu or the hub's "+" buttons run, so a
 * palette command and its button are one implementation. Archiving keeps the
 * header menu's behavior: it hides the project, and loses no data.
 */
export function useProjectCommands(
  input: ProjectCommandInput
): Record<ProjectCommandId, CommandImpl> {
  const { t } = useT('tasks')
  const { hasProject } = input
  const addTo = (tab: 'tasks' | 'notes' | 'files' | 'events'): string =>
    t('projectHub.sections.add', { title: t(`projectHub.tabs.${tab}`) })

  const commands: Record<ProjectCommandId, CommandImpl> = {
    'project.edit': {
      label: t('projectHub.header.editProject'),
      enabled: hasProject,
      run: input.openEditor
    },
    'project.archive': {
      label: t('projectHub.header.archiveProject'),
      enabled: hasProject && input.canArchive,
      run: input.archive
    },
    'project.addTask': { label: addTo('tasks'), enabled: hasProject, run: input.focusCapture },
    'project.addNote': { label: addTo('notes'), enabled: hasProject, run: input.addNote },
    'project.addFile': { label: addTo('files'), enabled: hasProject, run: input.openFilePicker },
    'project.addEvent': { label: addTo('events'), enabled: hasProject, run: input.addEvent }
  }

  useTabCommands('project', commands)
  return commands
}
