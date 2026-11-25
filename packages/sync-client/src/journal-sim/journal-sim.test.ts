import { describe, expect, it } from 'vitest'
import { readEnv } from '../env'
import { Rule } from './fleet'
import { judge, type Judgement, type LossClass } from './oracle'
import { CONFIGS, generate, run, shrink, type Scenario, type ServerMode } from './run'

// #5508: a seeded fleet of new and older desktop and core builds editing one
// journal day (chapter 06 §6.12), judged per edit by `oracle.ts`. CI runs
// seeds 1..1000 per config; JOURNAL_SIM_RUNS=20000 is the ship-bar run, and
// JOURNAL_SIM_TABLE prints the table.
const RUNS = Number(readEnv('JOURNAL_SIM_RUNS') ?? 1000)
const SERVERS: ServerMode[] = ['legacy', 'stamped']

type Tally = Record<LossClass, number> & {
  diverged: number
  livelock: number
  refDiverged: number
  first: Scenario | null
}

// `c` is allowed: older builds keep today's whole-record behaviour (Kaan,
// 2026-11-25). `d` is a loss: an over-claimed floor reads as no claim too.
const failed = (judgement: Judgement): boolean =>
  judgement.loss === 'a' ||
  judgement.loss === 'd' ||
  judgement.diverged ||
  judgement.livelock ||
  judgement.refDiverged

// Seeds a merged record floor over-claimed on: it claimed the losing side's
// unit, so a later concurrent write to that unit reverted (#5508 (a)).
const FLOOR_OVERCLAIM: [(typeof CONFIGS)[number], number][] = [
  ['newUntrusted', 15890],
  ['deskOnly', 7243],
  ['deskOnly', 7426],
  ['coreOnly', 17571],
  ['mixed', 17404]
]

function tally(config: (typeof CONFIGS)[number], server: ServerMode): Tally {
  const out: Tally = {
    a: 0,
    b: 0,
    c: 0,
    d: 0,
    diverged: 0,
    livelock: 0,
    refDiverged: 0,
    first: null
  }
  for (let seed = 1; seed <= RUNS; seed++) {
    const scenario = generate(config, server, seed)
    const judgement = judge(scenario)
    if (judgement.loss !== null) out[judgement.loss] += 1
    if (judgement.diverged) out.diverged += 1
    if (judgement.livelock) out.livelock += 1
    if (judgement.refDiverged) out.refDiverged += 1
    if (failed(judgement) && out.first === null) out.first = scenario
  }
  return out
}

/** A failing scenario, shrunk, with the run's log: what a red test prints. */
function explain(scenario: Scenario): string {
  const minimal = shrink(scenario, (s) => failed(judge(s)))
  const outcome = run(minimal, new Rule())
  return JSON.stringify(
    { scenario: minimal, judgement: judge(minimal), log: outcome.log, views: outcome.views },
    null,
    1
  )
}

describe('journal fleet simulator (#5508, chapter 06 §6.12)', () => {
  const table: string[] = []

  for (const config of CONFIGS) {
    for (const server of SERVERS) {
      it(`${config}/${server}: no new build reverts a write, and every device converges`, () => {
        const result = tally(config, server)
        table.push(
          `| ${config}/${server} | ${RUNS} | ${result.a} | ${result.b} | ${result.c} | ${result.d} | ` +
            `${result.diverged} | ${result.livelock} |`
        )
        const detail = result.first === null ? '' : explain(result.first)
        expect(
          {
            a: result.a,
            d: result.d,
            diverged: result.diverged,
            livelock: result.livelock,
            refDiverged: result.refDiverged
          },
          detail
        ).toEqual({ a: 0, d: 0, diverged: 0, livelock: 0, refDiverged: 0 })
      })
    }
  }

  it.each(FLOOR_OVERCLAIM)('%s seed %i: a unit floor claims only its value', (config, seed) => {
    const judgement = judge(generate(config, 'legacy', seed))
    expect(judgement.loss, explain(generate(config, 'legacy', seed))).toBeNull()
  })

  it.runIf(readEnv('JOURNAL_SIM_TABLE'))('prints the table', () => {
    expect(table.length).toBeGreaterThan(0)
    console.log(
      '| config/server | runs | a | b | c | d | diverged | livelock |\n' +
        '| --- | --: | --: | --: | --: | --: | --: | --: |\n' +
        table.join('\n') +
        '\n'
    )
  })
})
