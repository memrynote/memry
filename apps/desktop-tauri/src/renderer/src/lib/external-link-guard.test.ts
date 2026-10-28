import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { watchDrops, watchExternalLinks, watchFormSubmits } from './external-link-guard'

const ORIGIN = 'http://localhost:3000'
const WEB = 'https://example.com/a?b=1'
const FILE = 'memry-file://local/v/attachments/a.zip'

/** Whether the engine will skip the default action (the navigation), whatever the page sees. */
const engineSkipsDefault = (event: Event): boolean =>
  Object.getOwnPropertyDescriptor(Event.prototype, 'defaultPrevented')?.get?.call(event) === true

/** The guard opens after the event's dispatch, once no handler claimed it. */
const afterDispatch = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const open = vi.fn(() => Promise.resolve())
let stops: Array<() => void> = []
beforeEach(() => {
  stops = [watchExternalLinks(window, open), watchDrops(window, open), watchFormSubmits(window)]
})
afterEach(() => {
  for (const stop of stops) stop()
  open.mockClear()
  document.body.innerHTML = ''
})

function byId(id: string): Element {
  const element = document.getElementById(id)
  if (!element) throw new Error(`no #${id}`)
  return element
}

function mouse(type: 'click' | 'auxclick', target: Element, init: MouseEventInit = {}): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, ...init })
  target.dispatchEvent(event)
  return event
}

function drag(
  type: 'dragenter' | 'dragover' | 'drop',
  target: Element,
  data: Record<string, string>
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: Object.keys(data), getData: (t: string) => data[t] ?? '', dropEffect: 'none' }
  })
  target.dispatchEvent(event)
  return event
}

/** One gesture: every event it fires, whether the engine skips each default, and the opens. */
async function gesture(fire: () => Event[]): Promise<{ cancelled: boolean[]; opened: unknown[] }> {
  const events = fire()
  await afterDispatch()
  return { cancelled: events.map(engineSkipsDefault), opened: open.mock.calls.map((c) => c[0]) }
}

const dragAll = (target: Element, data: Record<string, string>): Event[] =>
  (['dragenter', 'dragover', 'drop'] as const).map((type) => drag(type, target, data))

const link = { 'text/uri-list': `# comment\r\n${WEB}\r\n`, 'text/plain': WEB }
const file = { Files: '', 'text/uri-list': 'file:///home/u/a.pdf' }
const text = { 'text/plain': 'some words' }
const image = { 'text/uri-list': 'memry-file://local/v/a.png', 'text/html': '<img>' }
const LINK = `<a id="l" href="${WEB}"><span id="inner">x</span></a>`

describe('link activation', () => {
  const rows: Array<[string, string, () => Event[], boolean, string[]]> = [
    ['left click', LINK, () => [mouse('click', byId('inner'))], true, [WEB]],
    [
      'middle click (auxclick)',
      LINK,
      () => [mouse('auxclick', byId('inner'), { button: 1 })],
      true,
      [WEB]
    ],
    [
      'middle click an engine fires as click',
      LINK,
      () => [mouse('click', byId('l'), { button: 1 })],
      true,
      []
    ],
    ['right click', LINK, () => [mouse('auxclick', byId('l'), { button: 2 })], true, []],
    ['ctrl click', LINK, () => [mouse('click', byId('l'), { ctrlKey: true })], true, [WEB]],
    [
      'meta and shift click',
      LINK,
      () => [mouse('click', byId('l'), { metaKey: true, shiftKey: true })],
      true,
      [WEB]
    ],
    [
      'Enter (keyboard activation fires click, detail 0)',
      LINK,
      () => {
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })
        byId('l').dispatchEvent(event)
        return [event]
      },
      true,
      [WEB]
    ],
    [
      'mail link',
      '<a id="l" href="mailto:hi@memrynote.com">x</a>',
      () => [mouse('click', byId('l'))],
      true,
      ['mailto:hi@memrynote.com']
    ],
    [
      'SVG link',
      `<svg><a id="l" href="${WEB}"><text id="t">x</text></a></svg>`,
      () => [mouse('click', byId('t'))],
      true,
      [WEB]
    ],
    [
      'image map area',
      `<map name="m"><area id="l" href="${WEB}" shape="rect" coords="0,0,1,1"></map>`,
      () => [mouse('click', byId('l'))],
      true,
      [WEB]
    ],
    // Handed to the shell, which opens a vault file in its app and refuses the rest.
    [
      'vault file link',
      `<a id="l" href="${FILE}">x</a>`,
      () => [mouse('click', byId('l'))],
      true,
      [FILE]
    ],
    [
      'app page link',
      `<a id="l" href="${ORIGIN}/page">x</a>`,
      () => [mouse('click', byId('l'))],
      true,
      [`${ORIGIN}/page`]
    ],
    [
      'javascript: link',
      '<a id="l" href="javascript:void(0)">x</a>',
      () => [mouse('click', byId('l'))],
      true,
      ['javascript:void(0)']
    ],
    [
      'empty href (a reload)',
      '<a id="l" href="">x</a>',
      () => [mouse('click', byId('l'))],
      true,
      [`${ORIGIN}/`]
    ],
    [
      'fragment of this document',
      '<a id="l" href="#section">x</a>',
      () => [mouse('click', byId('l'))],
      false,
      []
    ],
    // The engines ignore `download` on another origin and navigate the window.
    [
      "a file block's Download (a vault file with download)",
      `<a id="l" href="${FILE}" download="a.zip">x</a>`,
      () => [mouse('click', byId('l'))],
      true,
      [FILE]
    ],
    [
      'a web link with download',
      `<a id="l" href="${WEB}" download>x</a>`,
      () => [mouse('click', byId('l'))],
      true,
      [WEB]
    ],
    [
      'a download of this origin',
      `<a id="l" href="${ORIGIN}/export.csv" download>x</a>`,
      () => [mouse('click', byId('l'))],
      false,
      []
    ],
    [
      'a blob: download (CSV export, recovery phrase)',
      '<a id="l" href="blob:http://localhost:3000/1" download>x</a>',
      () => [mouse('click', byId('l'))],
      false,
      []
    ],
    [
      'a data: download',
      '<a id="l" href="data:text/plain,x" download>x</a>',
      () => [mouse('click', byId('l'))],
      false,
      []
    ],
    ['a button', '<button id="l">x</button>', () => [mouse('click', byId('l'))], false, []]
  ]
  it.each(rows)('%s', async (_name, html, fire, cancelled, opened) => {
    document.body.innerHTML = html
    const result = await gesture(fire)
    expect(result.cancelled).toEqual([cancelled])
    expect(result.opened).toEqual(opened)
  })

  // WKWebView and WebKitGTK serve the app from `tauri://localhost`. By the URL standard a
  // non-special scheme has an opaque origin, serialized `"null"` like a vault file's, and two
  // opaque origins are never the same.
  it('follows a download from a page whose origin is opaque, as from any other origin', async () => {
    const page = vi.spyOn(document, 'URL', 'get').mockReturnValue('tauri://localhost/')
    document.body.innerHTML = `<a id="l" href="${FILE}" download="a.zip">x</a>`
    const result = await gesture(() => [mouse('click', byId('l'))])
    page.mockRestore()
    expect(result).toEqual({ cancelled: [true], opened: [FILE] })
  })

  it('takes a link inside a shadow root', async () => {
    document.body.innerHTML = '<div id="host"></div>'
    const root = byId('host').attachShadow({ mode: 'open' })
    root.innerHTML = `<a href="${WEB}"><span>x</span></a>`
    const inner = root.querySelector('span')
    if (!inner) throw new Error('no span')
    expect(await gesture(() => [mouse('click', inner)])).toEqual({
      cancelled: [true],
      opened: [WEB]
    })
  })

  it('takes a link whose click app handlers stop at every level', async () => {
    document.body.innerHTML = LINK
    const stopper = new AbortController()
    const { signal } = stopper
    window.addEventListener('click', (e) => e.stopImmediatePropagation(), { capture: true, signal })
    document.addEventListener('click', (e) => e.stopPropagation(), { capture: true, signal })
    byId('l').addEventListener('click', (e) => e.stopPropagation(), { signal })
    const result = await gesture(() => [mouse('click', byId('l'))])
    stopper.abort()
    expect(result).toEqual({ cancelled: [true], opened: [WEB] })
  })

  it('leaves a link to a component that claims it, which sees the event as before', async () => {
    document.body.innerHTML = LINK
    const seen: boolean[] = []
    byId('l').addEventListener('click', (event) => {
      seen.push(event.defaultPrevented)
      event.preventDefault()
      seen.push(event.defaultPrevented)
    })
    const result = await gesture(() => [mouse('click', byId('l'))])
    expect(seen).toEqual([false, true])
    expect(result).toEqual({ cancelled: [true], opened: [] })
  })
})

describe('drags', () => {
  const ZONE = `<div id="sidebar"><header id="head">x</header><div id="zone">x</div></div>`
  /** The sidebar file-drop zone (`useFileDrop`): it claims file drags over and onto it. */
  function mountZone(): string[] {
    document.body.innerHTML = ZONE
    const got: string[] = []
    const zone = byId('zone')
    zone.addEventListener('dragover', (e) => {
      if (!(e as Event & { dataTransfer: DataTransfer }).dataTransfer.types.includes('Files'))
        return
      got.push(`over ${String(e.defaultPrevented)}`)
      e.preventDefault()
      e.stopPropagation()
    })
    zone.addEventListener('drop', (e) => {
      got.push(`drop ${String(e.defaultPrevented)}`)
      e.preventDefault()
      e.stopPropagation()
    })
    return got
  }

  const rows: Array<[string, Record<string, string>, string, boolean, string[]]> = [
    ['a link dragged in, on a non-zone', link, 'head', true, [WEB]],
    ['a file, on a non-zone (the sidebar header)', file, 'head', true, []],
    ['text, on a non-zone', text, 'head', true, []],
    ['an app image, on a non-zone', image, 'head', true, []],
    // useFileDrop's drop handler claims every drop, and keeps only files.
    ['a link, on the file-drop zone', link, 'zone', true, []]
  ]
  it.each(rows)('%s', async (_name, data, target, cancelled, opened) => {
    mountZone()
    const result = await gesture(() => dragAll(byId(target), data))
    expect(result).toEqual({ cancelled: [cancelled, cancelled, cancelled], opened })
  })

  it('a file on the file-drop zone stays the zone’s, which sees the event as before', async () => {
    const got = mountZone()
    const result = await gesture(() => dragAll(byId('zone'), file))
    expect(got).toEqual(['over false', 'drop false'])
    expect(result).toEqual({ cancelled: [true, true, true], opened: [] })
  })

  const EDITABLE = `
    <div class="ProseMirror" contenteditable="true"><p id="p">x</p></div>
    <input id="text" /><input id="search" type="search" /><textarea id="area"></textarea>`

  it('leaves a link or text dragged over the editor and text fields to them', async () => {
    document.body.innerHTML = EDITABLE
    for (const id of ['p', 'text', 'search', 'area']) {
      for (const data of [link, text]) {
        const { cancelled } = await gesture(() => dragAll(byId(id), data))
        expect(cancelled, id).toEqual([false, false, false])
      }
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('takes a file dragged over the editor or a text field unless the editor claims it', async () => {
    document.body.innerHTML = EDITABLE
    for (const id of ['p', 'text', 'area']) {
      const { cancelled } = await gesture(() => dragAll(byId(id), file))
      expect(cancelled, id).toEqual([true, true, true])
    }
    const seen: boolean[] = []
    byId('p').addEventListener('drop', (event) => {
      seen.push(event.defaultPrevented)
      event.preventDefault()
    })
    await gesture(() => dragAll(byId('p'), file))
    expect(seen).toEqual([false])
    expect(open).not.toHaveBeenCalled()
  })

  it('takes drags over what is not editable: an island in the editor, a checkbox, a file input', async () => {
    document.body.innerHTML = `
      <div contenteditable="true"><div contenteditable="false"><span id="island">x</span></div></div>
      <input id="check" type="checkbox" /><input id="pick" type="file" />`
    for (const id of ['island', 'check', 'pick']) {
      expect((await gesture(() => dragAll(byId(id), file))).cancelled, id).toEqual([
        true,
        true,
        true
      ])
    }
  })

  it('takes a drop whose propagation a zone stops without claiming it', async () => {
    document.body.innerHTML = ZONE
    byId('head').addEventListener('drop', (e) => e.stopPropagation())
    expect(await gesture(() => dragAll(byId('head'), link))).toEqual({
      cancelled: [true, true, true],
      opened: [WEB]
    })
  })
})

describe('form submission', () => {
  function submit(): Event {
    const event = new Event('submit', { bubbles: true, cancelable: true })
    byId('f').dispatchEvent(event)
    return event
  }

  it('never lets a form the app does not handle load its action', async () => {
    document.body.innerHTML = '<form id="f" action="https://example.com/x"></form>'
    expect(await gesture(() => [submit()])).toEqual({ cancelled: [true], opened: [] })
  })

  it('leaves a form to its handler, which sees the event as before', async () => {
    document.body.innerHTML = '<form id="f"></form>'
    const seen: boolean[] = []
    byId('f').addEventListener('submit', (event) => {
      seen.push(event.defaultPrevented)
      event.preventDefault()
    })
    await gesture(() => [submit()])
    expect(seen).toEqual([false])
  })
})

describe('cleanup', () => {
  it('stops every listener', async () => {
    for (const stop of stops) stop()
    document.body.innerHTML = `${LINK}<form id="f"></form>`
    const events = [mouse('click', byId('l')), ...dragAll(byId('l'), file)]
    await afterDispatch()
    expect(events.map(engineSkipsDefault)).toEqual([false, false, false, false])
    expect(open).not.toHaveBeenCalled()
  })
})
