/**
 * Layer `text` of stage 4 (#3522): function-level oracle cases. `FNS` maps a
 * name to the TypeScript function the Rust port must reproduce (arguments and
 * result are JSON); `textCases` lists the cases of `layer-text.json`. Inputs only:
 * the expected output is whatever the TypeScript code returns.
 */
import type { OracleCase } from '../cases-frontmatter'
import type { MarkdownSource } from '../cases-bn'

export const FNS: Record<string, (...args: never[]) => unknown> = {}

export function textCases(_external: MarkdownSource[]): OracleCase[] {
  return []
}
