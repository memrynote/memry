// Maya's Lisbon trip notes (tagged travel) and her Studio North notes, from ../graph-edit/world.mjs,
// plus a fresh Lisbon note that links nothing and has no tag yet, so everything the app suggests for
// it comes from the on-device embeddings. A board mixes the two topics for "Suggest groups".
import { addWorld, writeCanvas } from '../graph-edit/world.mjs'

export const NOTE = 'Belém morning'

const BOARD = [
  ['Sintra day trip', 0, 0],
  ['Hero copy options', 360, 0],
  ['Restaurants to try', 720, 0],
  ['Style guide', 0, 260],
  ['Alfama apartments', 360, 260],
  ['Moodboard', 720, 260]
]

export default function ({ cli, write }) {
  cli(
    'notes',
    'create',
    NOTE,
    '--folder',
    'Lisbon',
    '--content',
    'Jerónimos Monastery when it opens, then pastéis de nata at the old bakery next door. Walk along the river to the tower and the MAAT.\n\nTram 15 back to Cais do Sodré for dinner by the water.'
  )
  const n = addWorld(cli)
  writeCanvas(write, {
    id: 'canvas_fall_planning',
    title: 'Fall planning',
    cards: BOARD.map(([title, x, y], i) => ({
      id: `card-${i}`,
      note: n[title],
      x,
      y,
      w: 300,
      h: 200
    }))
  })
}
