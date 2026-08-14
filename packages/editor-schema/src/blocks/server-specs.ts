/**
 * Headless block implementations for the main process.
 *
 * The main process needs these nodes registered for one reason only: it
 * converts the shared Y.Doc through y-prosemirror, whose response to a node
 * name its schema cannot build is to DELETE the element from the doc. A block
 * missing here is not a blank space in a preview — it is a replicated delete.
 *
 * So these carry the schema (from the shared configs) and nothing else. There
 * is no headless DOM to paint into and no caller that should try: `render`
 * throws rather than returning something plausible.
 */

import { createBlockSpec } from '@blocknote/core'
import { taskBlockConfig } from './configs'

export function createServerBlockSpecs() {
  return {
    taskBlock: createBlockSpec(taskBlockConfig, {
      render: () => {
        throw new Error('taskBlock server spec is serialization-only and must not be rendered')
      }
    })()
    // callout / file / youtubeEmbed / bookmark land with their configs.
  }
}
