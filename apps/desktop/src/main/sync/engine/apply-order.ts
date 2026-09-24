/**
 * FK parents must apply before their children (e.g. a task references its
 * project), but server cursor order is last-update order, not dependency
 * order. Lower rank applies first; unlisted types use the default middle rank.
 */
const PULL_APPLY_ORDER: Record<string, number> = {
  project: 0,
  folder_config: 0,
  tag_definition: 0,
  filter: 0,
  settings: 0,
  calendar_source: 0,
  agent_conversation: 0,
  task: 2,
  agent_message: 2,
  calendar_event: 2,
  calendar_external_event: 2,
  calendar_binding: 3
}

const applyRank = (type: string): number => PULL_APPLY_ORDER[type] ?? 1

export const sortByApplyOrder = <T extends { type: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => applyRank(a.type) - applyRank(b.type))
