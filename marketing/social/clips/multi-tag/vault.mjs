// Notes that carry two tags, so narrowing by both has something to narrow: Studio North's meetings
// are tagged client and meeting. The base vault's other meetings and client notes carry only one.
export default function ({ cli }) {
  cli(
    'notes',
    'update',
    'Studio North/Studio North Kickoff.md',
    '--tag',
    'meeting',
    '--tag',
    'client'
  )
  cli(
    'notes',
    'create',
    'Studio North feedback call',
    '--folder',
    'Studio North',
    '--tag',
    'meeting',
    '--tag',
    'client',
    '--content',
    'Round one on the homepage. Hero image too dark, pricing section to move up.'
  )
  cli(
    'notes',
    'create',
    'Studio North handoff meeting',
    '--folder',
    'Studio North',
    '--tag',
    'meeting',
    '--tag',
    'client',
    '--content',
    'Handoff plan: assets by Thursday, staging link Friday.'
  )
}
