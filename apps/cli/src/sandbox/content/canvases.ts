import type { Clock } from '../clock.ts'

export type CardEntity = 'note' | 'task' | 'calendar_event' | 'project' | 'file'

export interface CanvasCard {
  id: string
  entity: CardEntity
  /** Key into the matching context map (notes, tasks, events, projects, files). */
  key: string
  x: number
  y: number
  frame?: string
}

export interface CanvasSpec {
  key: string
  title: string
  /** Folder under canvases/. */
  folder: string
  heading: string
  frames: Array<{
    id: string
    name: string
    x: number
    y: number
    w: number
    h: number
    tag?: string
  }>
  cards: CanvasCard[]
  arrows: Array<{ id: string; from: string; to: string; dashed?: boolean }>
  notes: Array<{ id: string; text: string; x: number; y: number; color: string; href?: string }>
}

export function canvasSpecs(clock: Clock): CanvasSpec[] {
  return [
    {
      key: 'aurora-map',
      title: 'Aurora launch map',
      folder: 'Aurora',
      heading: 'Aurora 1.0 launch map',
      frames: [
        { id: 'frame-design', name: 'Design work', x: 0, y: 0, w: 920, h: 260, tag: 'design' }
      ],
      cards: [
        {
          id: 'card-critique',
          entity: 'note',
          key: 'reading-critique',
          x: 30,
          y: 50,
          frame: 'frame-design'
        },
        {
          id: 'card-reading-view',
          entity: 'task',
          key: 'a-reading-view',
          x: 330,
          y: 50,
          frame: 'frame-design'
        },
        {
          id: 'card-contrast',
          entity: 'task',
          key: 'a-contrast',
          x: 630,
          y: 50,
          frame: 'frame-design'
        },
        { id: 'card-project', entity: 'project', key: 'aurora', x: -340, y: 360 },
        { id: 'card-brief', entity: 'note', key: 'aurora-brief', x: 0, y: 360 },
        { id: 'card-prd', entity: 'note', key: 'aurora-prd', x: 330, y: 360 },
        { id: 'card-launch', entity: 'task', key: 'a-launch', x: 660, y: 360 },
        { id: 'card-review', entity: 'calendar_event', key: 'design-review', x: 990, y: 360 },
        { id: 'card-paper', entity: 'file', key: 'gestures-pdf', x: 990, y: 0 }
      ],
      arrows: [
        { id: 'arrow-project-brief', from: 'card-project', to: 'card-brief' },
        { id: 'arrow-brief-prd', from: 'card-brief', to: 'card-prd' },
        { id: 'arrow-prd-launch', from: 'card-prd', to: 'card-launch' },
        { id: 'arrow-critique-task', from: 'card-critique', to: 'card-reading-view', dashed: true }
      ],
      notes: [
        {
          id: 'sticky-hallway',
          text: 'Launch only when onboarding\npasses the hallway test',
          x: -340,
          y: 40,
          color: '#fff3bf'
        },
        {
          id: 'link-critique-day',
          text: 'Journal: critique day',
          x: -340,
          y: 600,
          color: '#e7f5ff',
          href: `memry://journal/${clock.date(-6)}?label=Critique+day`
        },
        {
          id: 'link-measure',
          text: 'Line length reference',
          x: 0,
          y: 600,
          color: '#ebfbee',
          href: 'https://practicaltypography.com/line-length.html'
        }
      ]
    },
    {
      key: 'essay-board',
      title: 'Space race essay board',
      folder: 'Essay',
      heading: 'Notes in the space race: structure',
      frames: [
        { id: 'frame-paper', name: 'Act I: paper', x: 0, y: 260, w: 640, h: 260 },
        { id: 'frame-voice', name: 'Act II: voice', x: 700, y: 260, w: 640, h: 260 },
        { id: 'frame-ending', name: 'Ending', x: 1400, y: 260, w: 640, h: 260 }
      ],
      cards: [
        { id: 'card-draft', entity: 'note', key: 'x-draft', x: 700, y: -20 },
        { id: 'card-agc', entity: 'note', key: 'r-agc', x: 30, y: 310, frame: 'frame-paper' },
        {
          id: 'card-checklists',
          entity: 'note',
          key: 'r-checklists',
          x: 340,
          y: 310,
          frame: 'frame-paper'
        },
        {
          id: 'card-flight-plan',
          entity: 'note',
          key: 'r-flight-plan',
          x: 730,
          y: 310,
          frame: 'frame-voice'
        },
        {
          id: 'card-capcom',
          entity: 'note',
          key: 'r-capcom',
          x: 1040,
          y: 310,
          frame: 'frame-voice'
        },
        {
          id: 'card-safire',
          entity: 'note',
          key: 'r-safire',
          x: 1430,
          y: 310,
          frame: 'frame-ending'
        },
        {
          id: 'card-apollo1',
          entity: 'note',
          key: 'r-apollo1',
          x: 1740,
          y: 310,
          frame: 'frame-ending'
        },
        { id: 'card-pillars', entity: 'file', key: 'pillars-image', x: 0, y: -40 }
      ],
      arrows: [
        { id: 'arrow-draft-agc', from: 'card-draft', to: 'card-agc' },
        { id: 'arrow-agc-checklists', from: 'card-agc', to: 'card-checklists' },
        { id: 'arrow-plan-capcom', from: 'card-flight-plan', to: 'card-capcom' },
        { id: 'arrow-capcom-safire', from: 'card-capcom', to: 'card-safire', dashed: true }
      ],
      notes: [
        {
          id: 'sticky-question',
          text: 'Where do the women computers\nfit? Act I or a new act?',
          x: 1400,
          y: 0,
          color: '#fff3bf'
        },
        {
          id: 'link-outline-day',
          text: 'Journal: the day the outline clicked',
          x: 1400,
          y: 600,
          color: '#e7f5ff',
          href: `memry://journal/${clock.date(-13)}?label=Outline+day`
        },
        {
          id: 'link-hamilton',
          text: 'Margaret Hamilton on Wikipedia',
          x: 0,
          y: 600,
          color: '#ebfbee',
          href: 'https://en.wikipedia.org/wiki/Margaret_Hamilton_(software_engineer)'
        }
      ]
    }
  ]
}
