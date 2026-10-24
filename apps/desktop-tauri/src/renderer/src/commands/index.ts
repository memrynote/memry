/**
 * Command runtime. Owners register behavior for the commands in
 * `@memry/contracts/commands`; every caller (keyboard, menu, palette, button)
 * invokes it through `runCommand`. Import from here, never from a sibling file.
 */

export { useAppCommands, useTabCommands } from './use-command-impls'
export { AppCommandOwners } from './app-command-owners'
export { WorkspaceCommandOwners } from './workspace-command-owners'
export { runCommand } from './run-command'
export { registerFolderNoteRunner } from './folder-note-runner'
export { useEditorTarget, type EditorHandle } from './editor-target'
export { useCommandDispatcher } from './use-command-dispatcher'
export { LOCAL_COMMAND_MENU_ATTR } from './local-command-menu'
export { publishActiveContext, useAvailableCommands } from './store'
export type {
  ActiveContext,
  CommandImpl,
  CommandOutcome,
  CommandSource,
  OwnerImpls,
  RunContext
} from './types'
