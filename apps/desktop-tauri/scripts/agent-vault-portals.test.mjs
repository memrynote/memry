import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, it } from 'node:test'

import { seedPortalExamples } from './agent-vault-portals.mjs'

const BINDINGS = readFileSync(new URL('../src/generated/bindings.ts', import.meta.url), 'utf8')

/** The argument names each generated command sends: `__TAURI_INVOKE<T>("name", { a, b })`. */
function generatedArgs(command) {
  const call = new RegExp(`__TAURI_INVOKE<[^>]*>\\("${command}"(?:, \\{ ([^}]*) \\})?\\)`)
  const match = BINDINGS.match(call)
  assert.ok(match, `${command} is not a generated command`)
  return match[1] ? match[1].split(', ') : []
}

/** The field names of a generated object type. */
function generatedFields(type) {
  const block = BINDINGS.match(new RegExp(`export type ${type} = \\{([\\s\\S]*?)\\n\\};`))
  assert.ok(block, `${type} is not a generated type`)
  return [...block[1].matchAll(/^\t(\w+)\??:/gm)].map((field) => field[1])
}

after(() => {
  delete globalThis.window
})

it('waits for the vault, then creates the notes through the generated commands with portal fences naming the ids it got back', async () => {
  const calls = []
  const lists = [
    // Tauri rejects with the serialized `CommandError`, a plain object.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the shape a command rejects with
    () => Promise.reject({ kind: 'NotFound', code: 'no_vault_open' }),
    () => Promise.resolve({ notes: [], total: 0, hasMore: false }),
    () => Promise.resolve({ notes: [{ id: 'n0' }], total: 3, hasMore: true })
  ]
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: (command, args) => {
          calls.push({ command, args })
          if (command === 'notes_list') return lists.shift()()
          return Promise.resolve({ id: `id-${args.input.title}` })
        }
      }
    }
  }

  assert.equal(await seedPortalExamples(), 'Created 6 portal example notes')

  assert.deepEqual(
    calls.map((call) => call.command),
    ['notes_list', 'notes_list', 'notes_list', ...Array(6).fill('notes_create')]
  )
  for (const { command, args } of calls) {
    assert.deepEqual(Object.keys(args), generatedArgs(command), command)
  }
  const listFields = generatedFields('NoteListOptions')
  assert.ok(Object.keys(calls[0].args.options).every((key) => listFields.includes(key)))
  const createFields = generatedFields('NoteCreateInput')
  const created = new Map(calls.slice(3).map(({ args }) => [args.input.title, args.input]))
  for (const input of created.values()) {
    assert.ok(Object.keys(input).every((key) => createFields.includes(key)))
  }

  const fences = (title) =>
    [...created.get(title).content.matchAll(/```memry-portal\n([\s\S]*?)\n```/g)].map((fence) =>
      JSON.parse(fence[1])
    )
  assert.deepEqual(fences('Lecture 2'), [
    { v: 1, note: 'id-Lecture 1', blocks: ['dna1'], open: { dna1: { show: ['purpyr'] } } },
    { v: 1, note: 'id-Lecture 1', blocks: ['rna1', 'prot'] }
  ])
  assert.deepEqual(fences('Exam prep'), [
    { v: 1, note: 'id-Lecture 1', blocks: ['dna1'], open: { dna1: { hide: [] } } },
    { v: 1, note: 'id-Cell glossary' },
    { v: 1, search: { text: 'DNA', limit: 20 } }
  ])
  assert.deepEqual(fences('ACLS drills'), [
    { v: 1, note: 'id-Cardiac arrest', blocks: ['rosc'], open: { rosc: { show: ['sat94'] } } }
  ])
  assert.match(created.get('Lecture 1').content, /^- DNA \^dna1$/m)
})
