/**
 * Layer `markers` of stage 4 (#3522): function-level oracle cases for the
 * sidecar-marker modules of `@memry/shared` (block-markers, block-colors,
 * inline-colors, task-block, plain-checkbox, obsidian-tasks, link-card-marker).
 * `FNS` maps a name to the TypeScript function the Rust port must reproduce
 * (arguments and result are JSON); `markersCases` lists the cases of
 * `layer-markers.json`. Inputs only: the expected output is whatever the
 * TypeScript code returns.
 */
import type { OracleCase } from '../cases-frontmatter'
import type { MarkdownSource } from '../cases-bn'
import { colorMarkerCases } from './markers-cases-colors'
import { inlineCases } from './markers-cases-inline'
import { markdownCases } from './markers-cases-md'
import { taskCases } from './markers-cases-tasks'
import { MARKER_FNS } from './markers-fns'

export const FNS: Record<string, (...args: never[]) => unknown> = MARKER_FNS

export function markersCases(external: MarkdownSource[]): OracleCase[] {
  const lists = [
    ...colorMarkerCases(),
    ...inlineCases(),
    ...taskCases(),
    ...markdownCases(external)
  ]
  return lists.flatMap((list) => list.cases)
}
