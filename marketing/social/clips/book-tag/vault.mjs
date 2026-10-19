// Maya's reading shelf. Four notes are already tagged book, with Author, Shelf, Rating and
// Finished filled in; setup then adds the Book fields to that tag from the tag hub, the way
// anyone with an existing tag would. "Ways of Seeing" is the new book, untagged until the clip, and
// "Currently reading" holds a view of the books on the Reading shelf. Dates come from today.
export default function ({ cli, day }) {
  const book = (title, props) =>
    cli(
      'notes',
      'create',
      title,
      '--folder',
      'Reading',
      '--tag',
      'book',
      '--properties',
      JSON.stringify(props),
      '--content',
      `Notes on ${title}.`
    )
  book('Shape Up', { Author: 'Ryan Singer', Shelf: 'Read', Rating: 5, Finished: day(-160) })
  book('Grid Systems', {
    Author: 'Josef Müller-Brockmann',
    Shelf: 'Read',
    Rating: 4,
    Finished: day(-70)
  })
  book('Thinking in Systems', { Author: 'Donella Meadows', Shelf: 'Reading' })
  book('Braiding Sweetgrass', { Author: 'Robin Wall Kimmerer', Shelf: 'Reading' })
  cli('notes', 'create', 'Ways of Seeing', '--folder', 'Reading', '--content', 'Next on the shelf.')
  const view = JSON.stringify({
    source: { kind: 'tag', tag: 'book' },
    layout: 'list',
    filters: 'Shelf == "Reading"'
  })
  cli(
    'notes',
    'create',
    'Currently reading',
    '--folder',
    'Reading',
    '--content',
    `Books I'm in the middle of.\n\n\`\`\`memry-view\n${view}\n\`\`\`\n`
  )
}
