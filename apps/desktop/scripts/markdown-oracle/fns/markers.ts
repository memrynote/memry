/**
 * Layer `markers` of stage 4 (#3522): function-level oracle cases. `FNS` maps a
 * name to the TypeScript function the Rust port must reproduce (arguments and
 * result are JSON); `markersCases` lists the cases of `layer-markers.json`. Inputs only:
 * the expected output is whatever the TypeScript code returns.
 */
import type { OracleCase } from '../cases-frontmatter'
import type { MarkdownSource } from '../cases-bn'

export const FNS: Record<string, (...args: never[]) => unknown> = {}

export function markersCases(_external: MarkdownSource[]): OracleCase[] {
  return []
}
