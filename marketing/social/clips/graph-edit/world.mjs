// More of Maya's week for the week-3 clips (links, graph, canvas): the notes a freelance designer
// with one client (Studio North) and one trip (Lisbon) would have after a month, linked the way
// she would link them. The clips' vault.mjs files import it, so the graph and the canvases show
// one consistent vault. `skip` leaves out notes a clip creates on camera.

const NOTES = [
  [
    'Studio North',
    'Sitemap draft',
    'Five pages instead of twelve: Home, Work, Studio, Journal, Contact. Each case study is one long scroll under Work.\n\nBased on the [[Website Redesign Brief]] and what Jonas said at the [[Studio North Kickoff]].'
  ],
  [
    'Studio North',
    'Moodboard',
    'Concrete, oak and a lot of daylight. Big photos of the buildings, small quiet type.\n\nShared with [[Lea Park]] before the [[Brand workshop with Lea]]. Colors follow the [[Design Principles]].'
  ],
  [
    'Studio North',
    'Hero copy options',
    '1. Small buildings, big care\n2. Architecture for public life\n3. Libraries, schools and a ferry terminal\n\n[[Jonas Weber]] likes the second one. It goes in the hero from [[Homepage Ideas]].'
  ],
  [
    'Studio North',
    'Case studies',
    'One long scroll per project: the problem, three photos, the plan, a quote from the client.\n\nStart with the ferry terminal. Page order in the [[Sitemap draft]].'
  ],
  [
    'Studio North',
    'Mobile navigation',
    'Two prototypes: a menu button and a bottom bar. [[Sam Okafor]] builds both so we can test them on real phones.\n\nWe decide at the [[Weekly sync with Sam]].'
  ],
  [
    'Studio North',
    'Style guide',
    'Serif headings, system body text, two greys and one warm accent. One page the Studio North team can keep using after launch.\n\nFrom the [[Brand workshop with Lea]].'
  ],
  [
    'Studio North',
    'Feedback round 1',
    'From [[Lea Park]], numbered as always:\n\n1. Hero photo is too dark\n2. Love the case study scroll\n3. Footer needs the address\n\nApplies to [[Homepage Ideas]] and the [[Moodboard]].'
  ],
  [
    'Lisbon',
    'Budget',
    'Flights 240, apartment 480 for four nights, food 200, the Sintra train 20. About 950 euros in total.\n\nDays as in the [[Lisbon Itinerary]].',
    ['travel']
  ],
  [
    'Lisbon',
    'Sintra day trip',
    'Train from Rossio, 40 minutes. Pena Palace early, before the crowds.\n\n[[Sam Okafor]] says skip the Moorish castle if it rains. Day 2 of the [[Lisbon Itinerary]].',
    ['travel']
  ],
  [
    'Lisbon',
    'Alfama apartments',
    'Three options near the castle, all with a view over the river. Book before the end of the month, they go fast.\n\nFrom [[Lisbon Ideas]].',
    ['travel']
  ],
  [
    'Lisbon',
    'Restaurants to try',
    'Time Out Market on the first night. Taberna da Rua das Flores: no reservations, go early. Pastéis de Belém on the way back from Sintra.\n\nFrom [[Lisbon Ideas]].',
    ['travel']
  ],
  [
    'People',
    'Ana Costa',
    'Photographer in Lisbon, a friend of [[Sam Okafor]]. Knows Alfama street by street and offered to show me the miradouros at sunset.'
  ],
  [
    'People',
    'Priya Shah',
    'Designer friend who runs the monthly design meetup. Wants to co-teach the [[Design systems workshop]] with me.'
  ],
  [
    'Ideas',
    'Newsletter for past clients',
    'Twice a year and short: what I made, one thing I learned, one book.\n\nThe first issue could feature [[Studio North]]. From the [[Ideas backlog]].'
  ],
  [
    'Ideas',
    'Design systems workshop',
    'A weekend workshop on tokens, components and the boring parts that make a site last. Co-teach with [[Priya Shah]].\n\nShaped like [[Notes on Shape Up]]. From the [[Ideas backlog]].'
  ],
  [
    'Ideas',
    'Portfolio refresh',
    'Three projects out, two in. Studio North leads once it ships, written up like the [[Case studies]].'
  ],
  [
    'Reading',
    'Refactoring UI',
    'Start with too much white space, then take it away. No grey text on colored backgrounds.\n\nFeeds my [[Design Principles]]. On the [[Reading List]].'
  ],
  [
    'Reading',
    'Four Thousand Weeks',
    "Sam's book tip. Finitude as a feature: pick fewer things and finish them.\n\nOn the [[Reading List]]."
  ],
  [
    'Meetings',
    'Design review with Studio North',
    'With [[Jonas Weber]] and [[Lea Park]]. Homepage approved, with two changes from [[Feedback round 1]].\n\nNext: [[Case studies]] and the [[Style guide]].',
    ['meeting']
  ]
]

/** Adds the notes. Returns every note in the vault by title (base ones included). */
export function addWorld(cli, { skip = [] } = {}) {
  for (const [folder, title, content, tags = []] of NOTES) {
    if (skip.includes(title)) continue
    cli(
      'notes',
      'create',
      title,
      '--folder',
      folder,
      '--content',
      content,
      ...tags.flatMap((t) => ['--tag', t])
    )
  }
  const notes = notesByTitle(cli)
  // The base vault's trip notes carry the trip as a project property only; tag them like the rest.
  for (const t of ['Lisbon Ideas', 'Lisbon Itinerary', 'Lisbon Packing List'])
    cli('notes', 'update', notes[t].id, '--tag', 'travel')
  return notesByTitle(cli)
}

export const notesByTitle = (cli) =>
  Object.fromEntries(cli('notes', 'list', '--limit', '500').map((n) => [n.title, n]))

// ---- canvases -------------------------------------------------------------------------------
// Canvases have no CLI command. The app owns them as plain Excalidraw files under canvases/: on
// vault open it adopts every canvases/**/*.excalidraw it has no row for, keeps the id in the file's
// `memry` sidecar and indexes its cards and arrows (apps/desktop/src/main/canvas/reconcile.ts). The
// CLI's sandbox generator makes its demo canvases the same way (apps/cli/src/sandbox/steps/canvases.ts),
// and a note card is a rectangle with customData { entityType: 'note', entityId } as the app writes it.

export const CARD = { w: 260, h: 168 }

function base(id, type, x, y, w, h, seed) {
  return {
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: [],
    updated: 0,
    link: null,
    locked: false
  }
}

/**
 * Writes canvases/<title>.excalidraw. `cards`: [{ id, note | task, x, y, w?, h?, frame? }] where
 * `note` is a note from addWorld and `task` a task from the CLI. `frames`: [{ id, name, x, y, w, h,
 * binding? }], a frame's cards listed right before it as the app keeps them. `arrows`:
 * [{ id, from, to }] between card ids.
 */
export function writeCanvas(write, { id, title, cards, frames = [], arrows = [] }) {
  let seed = 1
  const els = new Map()
  for (const c of cards) {
    els.set(c.id, {
      ...base(c.id, 'rectangle', c.x, c.y, c.w ?? CARD.w, c.h ?? CARD.h, seed++),
      strokeColor: '#ced4da',
      backgroundColor: '#ffffff',
      roundness: { type: 3 },
      frameId: c.frame ?? null,
      customData: c.task
        ? { entityType: 'task', entityId: c.task.id }
        : { entityType: 'note', entityId: c.note.id }
    })
  }
  // A frame's cards sit directly before it in the element array (canvas-frame-binding.ts placeInFrame).
  const ordered = []
  for (const f of frames) {
    ordered.push(...cards.filter((c) => c.frame === f.id).map((c) => els.get(c.id)))
    ordered.push({
      ...base(f.id, 'frame', f.x, f.y, f.w, f.h, seed++),
      strokeColor: '#bbb',
      strokeWidth: 2,
      name: f.name,
      ...(f.binding ? { customData: { memryBinding: f.binding } } : {})
    })
  }
  ordered.push(...cards.filter((c) => !c.frame).map((c) => els.get(c.id)))
  const arrowEls = arrows.map((a) => {
    const from = els.get(a.from)
    const to = els.get(a.to)
    const s = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
    const e = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
    for (const card of [from, to]) card.boundElements.push({ type: 'arrow', id: a.id })
    return {
      ...base(a.id, 'arrow', s.x, s.y, Math.abs(e.x - s.x), Math.abs(e.y - s.y), seed++),
      strokeWidth: 2,
      roundness: { type: 2 },
      points: [
        [0, 0],
        [e.x - s.x, e.y - s.y]
      ],
      lastCommittedPoint: null,
      startBinding: { elementId: a.from, focus: 0, gap: 4 },
      endBinding: { elementId: a.to, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false
    }
  })
  const now = Date.now()
  const scene = {
    type: 'excalidraw',
    version: 2,
    source: 'memry',
    memry: { id, createdAt: now, updatedAt: now },
    elements: [...ordered, ...arrowEls],
    appState: { gridSize: 20, viewBackgroundColor: '#ffffff' },
    files: {}
  }
  return write(`canvases/${title}.excalidraw`, `${JSON.stringify(scene, null, 2)}\n`)
}
