/**
 * Layer `blocks` of stage 4 (#3522): function-level oracle cases. `FNS` maps a
 * name to the TypeScript function the Rust port must reproduce (arguments and
 * result are JSON); `blocksCases` lists the cases of `layer-blocks.json`. Inputs only:
 * the expected output is whatever the TypeScript code returns.
 */
import type { OracleCase } from '../cases-frontmatter'
import type { MarkdownSource } from '../cases-bn'

export const FNS: Record<string, (...args: never[]) => unknown> = {}

export function blocksCases(_external: MarkdownSource[]): OracleCase[] {
  return []
}
