// A Studio North board (a plain .excalidraw file, as the app writes canvases): three of Maya's notes
// and a task as live cards, on top of the rest of her month (../graph-edit/world.mjs). Nothing links
// to Hero copy options yet, so the arrow drawn on camera gives it its first backlink.
import { addWorld, writeCanvas } from '../graph-edit/world.mjs'

export default function ({ cli, write }) {
  const n = addWorld(cli)
  const task = cli('tasks', 'list', '--limit', '200').find(
    (t) => t.title === 'Write headline options'
  )
  const size = { w: 300, h: 250 }
  writeCanvas(write, {
    id: 'canvas_studionorth_board',
    title: 'Studio North board',
    cards: [
      { id: 'card-homepage', note: n['Homepage Ideas'], x: 0, y: 0, ...size },
      { id: 'card-hero', note: n['Hero copy options'], x: 420, y: 0, ...size },
      { id: 'card-task', task, x: 0, y: 360, w: 300, h: 168 },
      { id: 'card-moodboard', note: n['Moodboard'], x: 420, y: 360, w: 300, h: 200 }
    ]
  })
}
