// Maya's month (../graph-edit/world.mjs), a short Homepage Ideas note to sketch the hero in, and an
// existing Studio North board (a plain .excalidraw file, as the app writes canvases) to embed with @.
import { addWorld, writeCanvas } from '../graph-edit/world.mjs'

export default function ({ cli, write }) {
  const n = addWorld(cli)
  cli(
    'notes',
    'update',
    n['Homepage Ideas'].id,
    '--content',
    'Lead with one calm line, then the work. One big photo of a building, one sentence, one button.\n\nPulled from [[Studio North Kickoff]] and [[Design Principles]].'
  )
  writeCanvas(write, {
    id: 'canvas_studionorth_board',
    title: 'Studio North board',
    cards: [
      { id: 'card-hero', note: n['Hero copy options'], x: 0, y: 0, w: 300, h: 220 },
      { id: 'card-mood', note: n['Moodboard'], x: 340, y: 0, w: 300, h: 220 },
      { id: 'card-style', note: n['Style guide'], x: 680, y: 0, w: 300, h: 220 }
    ],
    arrows: [{ id: 'arrow-1', from: 'card-mood', to: 'card-style' }]
  })
}
