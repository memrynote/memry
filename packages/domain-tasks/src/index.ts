import { createTasksCommands } from './commands.ts'
import type { CreateTasksCommandsDeps } from './commands-types.ts'
import { createTasksQueries, type TasksQueryRepository } from './queries.ts'

export * from './types.ts'
export * from './queries.ts'
export * from './commands-types.ts'
export * from './commands.ts'
export * from './tree.ts'

export function createTasksDomain(
  deps: CreateTasksCommandsDeps & {
    repository: CreateTasksCommandsDeps['repository'] & TasksQueryRepository
  }
) {
  return {
    ...createTasksQueries(deps.repository),
    ...createTasksCommands(deps)
  }
}
