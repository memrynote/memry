import { createLogger } from '../lib/logger'
import { getProjectById, isMarkdownNote } from '../database/queries/projects'
import { getEntityPropertiesRecord, setEntityProperties } from '../notes/entity-properties'
import { readProjectNames, withProjectName, withoutProjectName } from '../notes/project-property'
import { PROJECT_PROPERTY_KEY } from '@memry/contracts/property-types'
import type { DataDb } from '../database/types'

const logger = createLogger('IPC:ProjectItemLinks')

interface LinkInput {
  projectId: string
  itemType: string
  itemId: string
}

interface LinkDomain {
  linkItemToProject(input: LinkInput): Promise<{ success: boolean; error?: string }>
  unlinkItemFromProject(input: LinkInput): Promise<{ success: boolean; error?: string }>
}

async function writeNames(
  itemId: string,
  next: (names: string[], projectName: string) => string[],
  projectName: string
): Promise<{ success: true } | { success: false; error: string }> {
  const properties = getEntityPropertiesRecord(itemId)
  if (!properties) return { success: false, error: 'Entity not found' }

  const names = next(readProjectNames(properties), projectName)
  const result = await setEntityProperties(itemId, {
    ...properties,
    [PROJECT_PROPERTY_KEY]: names
  })
  return result.success ? { success: true } : { success: false, error: result.error }
}

/**
 * A markdown note's project membership lives in its frontmatter; the projector
 * derives the link row. Writing the row here instead would have it deleted on the
 * note's next index pass. Every other item kind keeps the table-native path.
 */
export async function linkProjectItem(
  db: DataDb,
  domain: LinkDomain,
  input: LinkInput
): Promise<{ success: boolean; error?: string }> {
  if (!isMarkdownNote(db, input.itemId)) {
    const result = await domain.linkItemToProject(input)
    return result.success
      ? { success: true }
      : { success: false, error: result.error ?? 'Failed to link item' }
  }

  const project = getProjectById(db, input.projectId)
  if (!project) return { success: false, error: 'Project not found' }

  logger.debug('link via frontmatter', { itemId: input.itemId, project: project.name })
  return writeNames(input.itemId, withProjectName, project.name)
}

export async function unlinkProjectItem(
  db: DataDb,
  domain: LinkDomain,
  input: LinkInput
): Promise<{ success: boolean; error?: string }> {
  if (!isMarkdownNote(db, input.itemId)) {
    const result = await domain.unlinkItemFromProject(input)
    return result.success
      ? { success: true }
      : { success: false, error: result.error ?? 'Failed to unlink item' }
  }

  const project = getProjectById(db, input.projectId)
  if (!project) return { success: false, error: 'Project not found' }

  return writeNames(input.itemId, withoutProjectName, project.name)
}
