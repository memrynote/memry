import { createTasksCommands, type CreateTasksCommandsDeps } from './commands'
import { createTasksQueries, type TasksQueryRepository } from './queries'

export * from './types'
export * from './queries'
export * from './commands'

export function createTasksDomain(
  deps: CreateTasksCommandsDeps & { repository: CreateTasksCommandsDeps['repository'] & TasksQueryRepository }
) {
  return {
    ...createTasksQueries(deps.repository),
    ...createTasksCommands(deps)
  }
}
