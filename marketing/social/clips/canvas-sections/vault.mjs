// Maya's Studio North deliverables, each with a status (Draft, In review, Done), scattered on a
// board (a plain .excalidraw file, as the app writes canvases), on top of the rest of her month
// (../graph-edit/world.mjs). Nothing is in review yet, so "Lay out by property" leaves that
// section empty for the card dropped in on camera.
import { addWorld, writeCanvas } from '../graph-edit/world.mjs'

const STATUS = {
  categories: {
    todo: { label: 'To-do', options: [{ value: 'Draft', color: 'stone', default: true }] },
    in_progress: { label: 'In progress', options: [{ value: 'In review', color: 'amber' }] },
    done: { label: 'Complete', options: [{ value: 'Done', color: 'emerald' }] }
  }
}

// Element order is the order "Lay out by property" fills a section in: Style guide first puts Hero
// copy options in the Draft section's right column, clear of Excalidraw's style panel on the left.
const CARDS = [
  ['Style guide', 'Draft', 680, 20],
  ['Hero copy options', 'Draft', 0, 30],
  ['Sitemap draft', 'Done', 330, -40],
  ['Moodboard', 'Done', 60, 260],
  ['Case studies', 'Draft', 400, 230],
  ['Mobile navigation', 'Draft', 740, 280]
]

export default function ({ cli, write }) {
  const n = addWorld(cli)
  cli('properties', 'define', 'status', 'status', '--options', JSON.stringify(STATUS))
  for (const [title, status] of CARDS)
    cli(
      'notes',
      'update',
      n[title].id,
      '--properties',
      JSON.stringify({ ...n[title].properties, status })
    )
  writeCanvas(write, {
    id: 'canvas_studionorth_pipeline',
    title: 'Studio North pipeline',
    cards: CARDS.map(([title, , x, y], i) => ({ id: `card-${i}`, note: n[title], x, y }))
  })
}
