import { describe, expect, it } from 'vitest'
import { Rule } from './fleet'
import {
  CONFIGS,
  generate,
  judge,
  run,
  shrink,
  violations,
  type Scenario,
  type ServerMode,
  type Verdict
} from './run'

// #5508: a seeded fleet of new and older desktop and core builds editing one
// journal day (chapter 06 §6.12). JOURNAL_SIM_RUNS raises the run count
// locally; JOURNAL_SIM_TABLE prints the table.
const RUNS = Number(process.env.JOURNAL_SIM_RUNS ?? 300)
const SERVERS: ServerMode[] = ['legacy', 'stamped']

interface Tally {
  runs: number
  losses: number
  diverged: number
  divergedSet: number
  livelock: number
  violated: number
  refViolated: number
  refDiverged: number
  first: Scenario | null
}

const failed = (verdict: Verdict): boolean =>
  verdict.losses.length > 0 || verdict.diverged || verdict.livelock || verdict.refDiverged

function tally(config: (typeof CONFIGS)[number], server: ServerMode): Tally {
  const out: Tally = {
    runs: 0,
    losses: 0,
    diverged: 0,
    divergedSet: 0,
    livelock: 0,
    violated: 0,
    refViolated: 0,
    refDiverged: 0,
    first: null
  }
  for (let seed = 1; seed <= RUNS; seed++) {
    const scenario = generate(config, server, seed)
    const verdict = judge(scenario, new Rule(), new Rule())
    out.runs += 1
    if (verdict.losses.length > 0) out.losses += 1
    if (verdict.diverged) out.diverged += 1
    if (verdict.divergedSet) out.divergedSet += 1
    if (verdict.livelock) out.livelock += 1
    if (verdict.violated) out.violated += 1
    if (verdict.refViolated) out.refViolated += 1
    if (verdict.refDiverged) out.refDiverged += 1
    if (failed(verdict) && out.first === null) out.first = scenario
  }
  return out
}

/** A failing scenario, shrunk, with the run's log: what a red test prints. */
function explain(scenario: Scenario): string {
  const minimal = shrink(scenario, (s) => failed(judge(s, new Rule(), new Rule())))
  const outcome = run(minimal, new Rule())
  return JSON.stringify(
    {
      scenario: minimal,
      verdict: judge(minimal, new Rule(), new Rule()),
      violations: violations(outcome),
      log: outcome.log,
      views: outcome.views
    },
    null,
    1
  )
}

describe('journal fleet simulator (#5508, chapter 06 §6.12)', () => {
  const table: string[] = []

  for (const config of CONFIGS) {
    for (const server of SERVERS) {
      it(`${config}/${server}: no loss against the document rule, and every device converges`, () => {
        const result = tally(config, server)
        table.push(
          `| ${config}/${server} | ${result.runs} | ${result.losses} | ${result.diverged} | ` +
            `${result.divergedSet} | ${result.livelock} | ${result.violated} | ${result.refViolated} |`
        )
        const detail = result.first === null ? '' : explain(result.first)
        expect(
          {
            losses: result.losses,
            diverged: result.diverged,
            livelock: result.livelock,
            refDiverged: result.refDiverged
          },
          detail
        ).toEqual({ losses: 0, diverged: 0, livelock: 0, refDiverged: 0 })
      })
    }
  }

  it.runIf(process.env.JOURNAL_SIM_TABLE)('prints the table', () => {
    expect(table.length).toBeGreaterThan(0)
    process.stdout.write(
      '| config/server | runs | losses | diverged | diverged (set) | livelock | (a) violated | (a) violated, document rule |\n' +
        '| --- | --: | --: | --: | --: | --: | --: | --: |\n' +
        table.join('\n') +
        '\n'
    )
  })
})
