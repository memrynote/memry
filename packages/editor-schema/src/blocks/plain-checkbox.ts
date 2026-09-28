/**
 * BlockNote's own check list item, plus `plain`: set on a checkbox the user
 * keeps as a checkbox, which the editor then never turns into a task.
 *
 * Here, in the shared schema, rather than in one surface: y-prosemirror builds
 * a node from the attributes its schema declares and drops the rest, so a
 * surface without the prop would write every plain checkbox back as an
 * ordinary one. Older builds are that surface. They keep the node (unknown
 * attributes are ignored, not deleted), lose the flag, and convert the line
 * into a task on their next open — the behaviour every checkbox had before.
 *
 * The prop never reaches the vault file on its own; the markdown carries it as
 * a trailing `{check}` (`@memry/shared/plain-checkbox`).
 */

import type { defaultBlockSpecs } from '@blocknote/core'

type CheckListItemSpec = typeof defaultBlockSpecs.checkListItem

export function withPlainCheckbox(spec: CheckListItemSpec) {
  return {
    ...spec,
    config: {
      ...spec.config,
      propSchema: {
        ...spec.config.propSchema,
        plain: { default: false, type: 'boolean' as const }
      }
    }
  }
}
