/**
 * Layer `critic` of stage 4 (#3522): function-level oracle cases. `FNS` maps a
 * name to the TypeScript function the Rust port must reproduce (arguments and
 * result are JSON); `criticCases` lists the cases of `layer-critic.json`. Inputs only:
 * the expected output is whatever the TypeScript code returns.
 *
 * The layer covers CriticMarkup parsing and transforms, the writing tools
 * marker codec and frontmatter, and the image lift of editor-schema. Marks
 * carry UTF-16 offsets.
 */
import type { OracleCase } from '../cases-frontmatter'
import type { MarkdownSource } from '../cases-bn'
import { CRITIC_FNS } from './critic-fns'
import { liftCases } from './critic-cases-lift'
import { normalizeCases, transformCases } from './critic-cases-normalize'
import { parseCases, payloadCases, serializeCases } from './critic-cases-parse'
import { writingCases } from './critic-cases-writing'

export const FNS: Record<string, (...args: never[]) => unknown> = CRITIC_FNS

export function criticCases(external: MarkdownSource[]): OracleCase[] {
  return [
    ...parseCases(external),
    ...serializeCases(),
    ...payloadCases(),
    ...normalizeCases(),
    ...transformCases(),
    ...writingCases(external),
    ...liftCases(external)
  ]
}
