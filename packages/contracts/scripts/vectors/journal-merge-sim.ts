/**
 * Class: journal field merge (`journal-merge-sim.json`), chapter 06 §6.12.
 *
 * The rule's calls, replayed from the #5508 fleet simulator
 * (`packages/sync-client/src/journal-sim`): every merge, and every edit whose
 * base carries `fieldFloors`, that a new build made in the five floor
 * over-claim seeds and in seeds 1..SEEDS of each config (legacy server). Each
 * input is recorded once. The Rust core replays the file in
 * `crates/memry-core/tests/journal_merge_vectors.rs`, so both builds run the
 * same rule on the histories a mixed fleet produces.
 *
 * Determinism: D1. The simulator is seeded and the rule is pure.
 */
import { Rule, type RuleCall } from '../../../sync-client/src/journal-sim/fleet.ts'
import { CONFIGS, generate, run } from '../../../sync-client/src/journal-sim/run.ts'
import { meta } from './shared'

const SEEDS = 20

/** The seeds `journal-sim.test.ts` pins against the floor over-claim (#5508 (a)). */
const PINNED: [(typeof CONFIGS)[number], number][] = [
  ['newUntrusted', 15890],
  ['deskOnly', 7243],
  ['deskOnly', 7426],
  ['coreOnly', 17571],
  ['mixed', 17404]
]

export function buildJournalMergeSim(): Record<string, unknown> {
  const runs = [
    ...PINNED,
    ...CONFIGS.flatMap((config) =>
      Array.from({ length: SEEDS }, (_, i) => [config, i + 1] as [(typeof CONFIGS)[number], number])
    )
  ]
  const seen = new Set<string>()
  const edits: unknown[] = []
  const merges: unknown[] = []
  for (const [config, seed] of runs) {
    const rule = new Rule(true)
    run(generate(config, 'legacy', seed), rule)
    ;(rule.calls ?? []).forEach((call: RuleCall, index) => {
      const name = `${config}-${seed}-${index}`
      if (call.fn === 'merge') {
        const key = JSON.stringify(['merge', call.local, call.remote, call.device])
        if (seen.has(key)) return
        seen.add(key)
        const { local, remote, device, out: expected } = call
        merges.push({ name, device, local, remote, expected })
      } else if (call.fn === 'edit' && call.base?.fieldFloors !== undefined) {
        const key = JSON.stringify(['edit', call.base, call.next])
        if (seen.has(key)) return
        seen.add(key)
        edits.push({ name, base: call.base, next: call.next, expected: call.out })
      }
    })
  }
  return {
    meta: meta({
      class: 'journal-merge',
      chapter: 'docs/protocol/06-vector-clocks-and-field-merge.md',
      implementation: 'packages/sync-client/src/journal-merge.ts',
      source: 'packages/sync-client/src/journal-sim',
      caseCount: edits.length + merges.length
    }),
    edits,
    merges
  }
}
