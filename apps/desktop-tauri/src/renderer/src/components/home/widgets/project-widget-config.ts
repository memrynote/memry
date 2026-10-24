/**
 * `WidgetInstance.config` is `Record<string, unknown>` and is persisted AND synced,
 * so anything read out of it may be missing, or written by another app version.
 * One total reader, shared by the body, the header and the config editor.
 */
export function readProjectId(config: Record<string, unknown>): string {
  return typeof config.projectId === 'string' ? config.projectId : ''
}
