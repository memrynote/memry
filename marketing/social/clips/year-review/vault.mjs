// Maya's reading notes (tag book, with their fields) and her own "Year in review" template: five
// questions, then a live view of the books she finished this year. Dates come from today.
export default function ({ cli, day }) {
  const year = Number(day(0).slice(0, 4))
  const books = [
    ['Shape Up', 'Ryan Singer', 'Read', 5, day(-160)],
    ['The Design of Everyday Things', 'Don Norman', 'Read', 4, day(-120)],
    ['Grid Systems', 'Josef Müller-Brockmann', 'Read', 4, day(-70)],
    ['Braiding Sweetgrass', 'Robin Wall Kimmerer', 'Read', 5, day(-30)],
    ['Thinking in Systems', 'Donella Meadows', 'Reading', 0, null],
    ['Ways of Seeing', 'John Berger', 'To read', 0, null]
  ]
  for (const [title, author, shelf, rating, finished] of books) {
    const props = { author, shelf }
    if (rating) props.rating = rating
    if (finished) props.finished = finished
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
  }
  const view = JSON.stringify({
    source: { kind: 'tag', tag: 'book' },
    layout: 'list',
    filters: `finished after "${year - 1}-12-31"`,
    order: [{ property: 'finished', direction: 'desc' }]
  })
  const content = `## What went well?

## What was hard?

## What did I learn?

## What am I proud of?

## What next year?

## Finished this year

\`\`\`memry-view
${view}
\`\`\`
`
  cli(
    'templates',
    'create',
    'Year in review',
    '--description',
    'Five questions and the books finished this year',
    '--content',
    content
  )
}
