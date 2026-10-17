// Maya's month (../graph-edit/world.mjs) plus what the links on camera point at: a Lisbon board (a
// plain .excalidraw file, as the app writes canvases), the journal day she booked the flights on
// (journal/2026-10-12 in the base vault), and a second note titled Budget, in Studio North, so the
// trip's Budget is linked by its folder path. "Lisbon prep" is the note the links are written in.
import { addWorld, writeCanvas } from '../graph-edit/world.mjs'

export const NOTE = 'Lisbon prep'

export default function ({ cli, write }) {
  cli(
    'notes',
    'create',
    'Budget',
    '--folder',
    'Studio North',
    '--content',
    'Redesign: 14,000 in total. Design 8,000, copy 2,500, build 3,500.\n\nAgreed in the [[Studio North Kickoff]].'
  )
  cli(
    'notes',
    'create',
    NOTE,
    '--folder',
    'Lisbon',
    '--tag',
    'travel',
    '--content',
    'Two weeks to go. What is left:'
  )
  const n = addWorld(cli)
  writeCanvas(write, {
    id: 'canvas_lisbon_board',
    title: 'Lisbon board',
    cards: [
      { id: 'card-itinerary', note: n['Lisbon Itinerary'], x: 0, y: 0 },
      { id: 'card-sintra', note: n['Sintra day trip'], x: 320, y: 0 },
      { id: 'card-food', note: n['Restaurants to try'], x: 640, y: 0 }
    ],
    arrows: [{ id: 'arrow-1', from: 'card-itinerary', to: 'card-sintra' }]
  })
}
