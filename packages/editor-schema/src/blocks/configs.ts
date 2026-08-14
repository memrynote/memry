/**
 * Block configs — type + propSchema + content, no presentation.
 *
 * A block's propSchema is its (de)serialization contract: the renderer's React
 * spec and the main process's headless spec have to agree exactly or
 * `yXmlFragmentToBlocks` mis-parses the props on one side. This used to be a
 * hand-copied duplicate carrying a comment asking humans to keep the two in
 * step; one object shared by both processes is what makes drift impossible.
 *
 * Presentation stays with each process — main has no React, and rendering is
 * never what reaches the vault file.
 */

export const taskBlockConfig = {
  type: 'taskBlock' as const,
  propSchema: {
    taskId: { default: '' },
    title: { default: '' },
    checked: { default: false },
    parentTaskId: { default: '' }
  },
  content: 'none' as const
}
