/**
 * Generates `task-superseded-id.json` by running Electron's
 * `taskSupersededActivityId` (`src/main/tasks/activity-log.ts`) in place as the
 * oracle.
 *
 *   pnpm --filter @memry/desktop vectors:task-superseded          # write the file
 *   pnpm --filter @memry/desktop vectors:task-superseded:check    # regenerate in memory, diff, write nothing
 *
 * The id is shared across devices: both sides of one task merge conflict mint
 * it from the field's merged clock, and insert-if-absent keeps one row
 * (docs/protocol/06-vector-clocks-and-field-merge.md §6.6.3). The Rust port
 * (`crates/memry-core/src/domain/task_activity/superseded.rs` `superseded_id`)
 * reproduces every case.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { taskSupersededActivityId } from '../../src/main/tasks/activity-log'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PATH = join(
  resolve(appRoot, '../../packages/contracts/test-vectors'),
  'task-superseded-id.json'
)

interface Case {
  name: string
  taskId: string
  field: string
  mergedClock: Record<string, number>
}

const CASES: Case[] = [
  {
    name: 'two devices',
    taskId: 'task-1',
    field: 'title',
    mergedClock: { 'device-a': 2, 'device-b': 1 }
  },
  {
    name: 'key order does not change the id',
    taskId: 'task-1',
    field: 'title',
    mergedClock: { 'device-b': 1, 'device-a': 2 }
  },
  {
    name: 'an offline component',
    taskId: 'task-1',
    field: 'title',
    mergedClock: { _offline: 1, 'device-b': 1 }
  },
  {
    name: 'keys sort by code unit',
    taskId: 'task-1',
    field: 'priority',
    mergedClock: { a: 3, _offline: 2, B: 1 }
  },
  { name: 'one device', taskId: 'task-1', field: 'dueDate', mergedClock: { 'device-a': 1 } },
  { name: 'an empty clock', taskId: 'task-1', field: 'title', mergedClock: {} },
  {
    name: 'a large counter',
    taskId: 'task-1',
    field: 'description',
    mergedClock: { 'device-a': 4294967296, 'device-b': 9007199254740991 }
  },
  {
    name: 'generated ids',
    taskId: 'k3x9m2p7q8r4s5t6',
    field: 'repeatConfig',
    mergedClock: {
      '0f8fad5b-d9cb-469f-a165-70867728950e': 7,
      '7c9e6679-7425-40de-944b-e07fc1f90ae7': 5
    }
  },
  {
    name: 'the separator splits task and field (1 of 2)',
    taskId: 'a b',
    field: 'c',
    mergedClock: { 'device-a': 1 }
  },
  {
    name: 'the separator splits task and field (2 of 2)',
    taskId: 'a',
    field: 'b c',
    mergedClock: { 'device-a': 1 }
  }
]

function render(): string {
  const cases = CASES.map((item) => ({
    ...item,
    expected: taskSupersededActivityId(item.taskId, item.field, item.mergedClock)
  }))
  const document = {
    meta: {
      spec: 'tauri-v2-3538-task-superseded-id',
      oracle:
        'apps/desktop/scripts/task-superseded-oracle (Electron src/main/tasks/activity-log.ts taskSupersededActivityId run in place)',
      chapter: 'docs/protocol/06-vector-clocks-and-field-merge.md §6.6.3',
      caseCount: cases.length
    },
    cases
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

function main(): void {
  const fresh = render()
  if (!process.argv.includes('--check')) {
    writeFileSync(PATH, fresh, 'utf8')
    process.stdout.write(`wrote ${PATH}\n`)
    return
  }
  let committed = ''
  try {
    committed = readFileSync(PATH, 'utf8')
  } catch {
    committed = ''
  }
  if (committed !== fresh) {
    process.stderr.write(
      'vectors:task-superseded:check failed: task-superseded-id.json is missing or regenerates differently.\n' +
        'Regenerate with `pnpm --filter @memry/desktop vectors:task-superseded`.\n'
    )
    process.exit(1)
  }
  process.stdout.write('vectors:task-superseded:check passed\n')
}

main()
