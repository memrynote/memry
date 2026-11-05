/**
 * Portal examples for the agent sandbox vault (`agent-app.mjs start`), the port of
 * `apps/desktop/scripts/agent-vault-portals.mjs`.
 *
 *   Lecture 1       the source: DNA and its children carry `^anchors`
 *   Lecture 2       a folded DNA portal that shows one child, and a two-root portal
 *   Exam prep       an opened portal, a whole-note portal, a search portal, a block link
 *   Cell glossary   the note Exam prep shows whole
 *   Cardiac arrest  a deeper source, for the toolbar's path crumbs
 *   ACLS drills     a portal of a nested child with its sibling left out
 *
 * `pnpm seed` writes the same examples into the demo vault (apps/desktop/scripts/seed-data/
 * portals.ts). A portal names its source by note id and ids are assigned by the app, so this
 * runs in the page after the vault opens and builds the fences from the ids it gets back. It
 * calls the generated bindings' commands (`notes_list`, `notes_create`) with their argument
 * names, through `window.__TAURI__` of the e2e build.
 */

/* oxlint-disable no-undef -- `window` exists in the page this function is sent to. */
export async function seedPortalExamples() {
  const { invoke } = window.__TAURI__.core
  // The vault opens a moment after the page loads: `notes_list` refuses until it is open, and
  // lists the vault's notes once its walk added them. Inside WebDriver's 30 s script timeout.
  const deadline = Date.now() + 20000
  for (;;) {
    const page = await invoke('notes_list', { options: { limit: 1 } }).catch(() => null)
    if (page && page.total > 0) break
    if (Date.now() > deadline) throw new Error('The vault did not list its notes in time')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- seedPortalExamples is serialized into the page, so its helpers must stay inside it
  const fence = (target) => '```memry-portal\n' + JSON.stringify(target, null, 2) + '\n```'
  const create = async (title, content) => {
    const note = await invoke('notes_create', { input: { title, content } })
    return note.id
  }
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- seedPortalExamples is serialized into the page, so its helpers must stay inside it
  const blocks = (note, roots, open) => ({ v: 1, note, blocks: roots, ...(open ? { open } : {}) })

  const lecture1 = await create(
    'Lecture 1',
    [
      '- Cells keep their instructions in DNA',
      '- DNA ^dna1',
      '  - double helix shape ^helx',
      '  - DNA is made of purines and pyrimidines ^purpyr',
      '  - Base pairs: A with T, C with G ^pairs',
      '- RNA copies DNA to build proteins ^rna1',
      '- Proteins fold into 3D shapes ^prot',
      ''
    ].join('\n')
  )
  const glossary = await create(
    'Cell glossary',
    [
      '- Nucleotide: one building block of DNA or RNA',
      '- Purine: adenine and guanine',
      '- Pyrimidine: cytosine, thymine and uracil',
      '- Ribosome: the machine that reads RNA',
      ''
    ].join('\n')
  )
  const cardiac = await create(
    'Cardiac arrest',
    [
      '- Cardiac arrest ^cara',
      '  - 50-year-old patient, unwitnessed collapse ^pt50',
      '    - First step: check for a pulse ^pulse',
      '    - Return of circulation: check pulse and rhythm ^rosc',
      '      - Oxygen saturation goal: 94% or higher ^sat94',
      '      - End-tidal CO2 goal: 35 to 40 ^etco2',
      ''
    ].join('\n')
  )

  await create(
    'Lecture 2',
    [
      '- Today: the structure of DNA',
      '',
      fence(blocks(lecture1, ['dna1'], { dna1: { show: ['purpyr'] } })),
      '',
      '- Next: how the code becomes a protein',
      '',
      fence(blocks(lecture1, ['rna1', 'prot'])),
      '',
      '- Questions for the seminar',
      ''
    ].join('\n')
  )
  await create(
    'Exam prep',
    [
      '- Review before Friday: [[Lecture 1#^dna1]]',
      '',
      fence(blocks(lecture1, ['dna1'], { dna1: { hide: [] } })),
      '',
      '- Terms to know',
      '',
      fence({ v: 1, note: glossary }),
      '',
      '- Everything I wrote about DNA',
      '',
      fence({ v: 1, search: { text: 'DNA', limit: 20 } }),
      ''
    ].join('\n')
  )
  await create(
    'ACLS drills',
    [
      '- Drill 3: after the shock',
      '',
      fence(blocks(cardiac, ['rosc'], { rosc: { show: ['sat94'] } })),
      '',
      '- Debrief',
      ''
    ].join('\n')
  )
  return 'Created 6 portal example notes'
}

/** The expression `evaluateInPage` runs in the page. */
export const PORTAL_EXAMPLES_EXPRESSION = `(${seedPortalExamples.toString()})()`
