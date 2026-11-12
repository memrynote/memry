// TEMPORARY instrumentation for #3967 FLAKE-7D. Not part of the final change.
import type { Page } from './pw-compat/page'

/** Records window/DOM focus, selection changes, transactions and the first cell's html in page memory. */
export async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __probe?: string[]
      __memryActiveEditor?: {
        getSelectedText(): string
        prosemirrorView?: {
          state: { selection: { from: number; to: number } }
          dispatch: (tr: unknown) => void
        }
      }
    }
    if (w.__probe) return
    const log: string[] = (w.__probe = [])
    const t0 = performance.now()
    const editorSel = (): string => {
      const view = w.__memryActiveEditor?.prosemirrorView
      return view ? `pm=${view.state.selection.from}-${view.state.selection.to}` : 'pm=none'
    }
    const stamp = (what: string): void => {
      log.push(
        `${(performance.now() - t0).toFixed(0)}ms ${what} hasFocus=${document.hasFocus()} ${editorSel()}`
      )
      if (log.length > 600) log.shift()
    }
    const describe = (target: EventTarget | null): string =>
      target instanceof Element
        ? `${target.tagName.toLowerCase()}.${(target.getAttribute('class') ?? '').slice(0, 30)}`
        : 'non-element'
    window.addEventListener('blur', () => stamp('window blur'), true)
    window.addEventListener('focus', () => stamp('window focus'), true)
    document.addEventListener('focusin', (e) => stamp(`focusin ${describe(e.target)}`), true)
    document.addEventListener('focusout', (e) => stamp(`focusout ${describe(e.target)}`), true)
    document.addEventListener('visibilitychange', () => stamp('visibilitychange'))
    document.addEventListener(
      'selectionchange',
      () => stamp(`selectionchange dom="${window.getSelection()?.toString() ?? ''}"`),
      true
    )
    for (const type of ['mousedown', 'mouseup', 'click'] as const) {
      document.addEventListener(
        type,
        (e) => {
          const bold = e.target instanceof Element ? e.target.closest('[data-test="bold"]') : null
          if (bold) stamp(`${type} on bold target=${describe(e.target)}`)
        },
        true
      )
    }
    document.addEventListener(
      'keydown',
      (e) => stamp(`keydown ${e.key} active=${describe(document.activeElement)}`),
      true
    )
    const view = w.__memryActiveEditor?.prosemirrorView
    if (view) {
      const original = view.dispatch.bind(view)
      view.dispatch = (tr: unknown) => {
        const t = tr as {
          docChanged: boolean
          selectionSet: boolean
          selection: { from: number; to: number }
          steps: { constructor: { name: string } }[]
          storedMarksSet: boolean
          meta: Record<string, unknown>
        }
        stamp(
          `dispatch docChanged=${t.docChanged} selectionSet=${t.selectionSet} sel=${t.selection.from}-${t.selection.to} ` +
            `steps=${t.steps.map((s) => s.constructor.name).join(',')} storedMarks=${t.storedMarksSet} meta=${Object.keys(t.meta ?? {}).join(',')}`
        )
        original(tr)
      }
    }
    for (const name of [
      'removeAllRanges',
      'empty',
      'collapse',
      'collapseToStart',
      'collapseToEnd',
      'addRange',
      'setBaseAndExtent',
      'setPosition'
    ] as const) {
      const proto = Selection.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >
      const original = proto[name]
      proto[name] = function (this: Selection, ...args: unknown[]) {
        stamp(
          `Selection.${name} called by ${new Error().stack?.split('\n').slice(1, 4).join(' | ').slice(0, 300)}`
        )
        return original.apply(this, args)
      }
    }
    let html = ''
    new MutationObserver(() => {
      const now = document.querySelector('.ProseMirror td')?.innerHTML ?? ''
      if (now !== html) {
        html = now
        stamp(`first cell html ${now.slice(0, 160)}`)
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
    stamp('probe installed')
  })
}

export async function probeLog(page: Page): Promise<string> {
  try {
    return await page.evaluate(() =>
      ((window as unknown as { __probe?: string[] }).__probe ?? []).slice(-90).join('\n')
    )
  } catch (error) {
    return `probe unreadable: ${String(error)}`
  }
}

/** The editor's selection, focus, the toolbar's bold button and the table cells' html. */
export async function cellState(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const editor = (window as unknown as { __memryActiveEditor?: { getSelectedText(): string } })
        .__memryActiveEditor
      const cells = [...document.querySelectorAll('.ProseMirror td')].map((td) => td.innerHTML)
      const active = document.activeElement
      const bold = document.querySelector('[data-test="bold"]')
      return JSON.stringify({
        selectedText: editor?.getSelectedText() ?? null,
        domSelection: window.getSelection()?.toString() ?? '',
        hasFocus: document.hasFocus(),
        active: active
          ? `${active.tagName}.${(active.getAttribute('class') ?? '').slice(0, 40)}`
          : null,
        bold: bold
          ? `${bold.getAttribute('data-selected')}/${bold.getAttribute('aria-pressed')}/${bold.getAttribute('data-state')}`
          : 'toolbar absent',
        cells
      })
    })
  } catch (error) {
    return `cell state unreadable: ${String(error)}`
  }
}
