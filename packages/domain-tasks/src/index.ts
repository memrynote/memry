import { createTasksCommands, type CreateTasksCommandsDeps } from './commands.ts'
import { createTasksQueries, type TasksQueryRepository } from './queries.ts'

export * from './types.ts'
export * from './queries.ts'
export * from './commands.ts'

export function createTasksDomain(
  deps: CreateTasksCommandsDeps & { repository: CreateTasksCommandsDeps['repository'] & TasksQueryRepository }
) {
  return {
    ...createTasksQueries(deps.repository),
    ...createTasksCommands(deps)
  }
}
