import { createTasksDomain, type TasksDomainPublisher } from '@memry/domain-tasks'
import { createTasksRepository } from '@memry/storage-data'
import * as taskQueries from '@main/database/queries/tasks'
import * as projectQueries from '@main/database/queries/projects'
import type { DataDb } from '../database'

export function createDesktopTasksDomain(
  db: DataDb,
  publisher: TasksDomainPublisher,
  generateId: () => string
) {
  return createTasksDomain({
    repository: createTasksRepository({
      db,
      taskQueries,
      projectQueries
    }),
    publisher,
    generateId
  })
}
