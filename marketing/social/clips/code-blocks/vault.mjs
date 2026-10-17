// The brand workshop's decisions go to Sam as CSS variables. The note ends on the line the clip
// pastes the snippet under; the snippet itself is on the clipboard (scenes.mjs setup), as if it
// had just been copied from the stylesheet.
export default function ({ cli }) {
  const note = cli('notes', 'list', '--limit', '500').find(
    (n) => n.title === 'Brand workshop with Lea'
  )
  cli(
    'notes',
    'update',
    note.id,
    '--append',
    `
## Tokens for Sam

The workshop's decisions, as CSS for the build:
`
  )
}
