// Design Principles grows two sections: Contrast, where the clip writes the WCAG contrast formula
// on camera, and Process, a Mermaid flowchart of the Studio North project that the clip extends.
export default function ({ cli }) {
  const note = cli('notes', 'list', '--limit', '500').find((n) => n.title === 'Design Principles')
  cli(
    'notes',
    'update',
    note.id,
    '--append',
    `
## Contrast

Body text needs at least 4.5:1 against its background.

## Process

\`\`\`mermaid
flowchart LR
  Brief --> Sketch --> Review
\`\`\`
`
  )
}
