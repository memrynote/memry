// SCRATCH (#4213 investigation) - not committed.
import { noteBody, openNewNote, setBlocks } from '../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../harness/notes'
import { tableBlock } from '../harness/table'
import { test, expect } from '../harness/test'

const TABLE_DOC = [
  tableBlock([
    ['Task', 'State'],
    ['Shipping', 'Open']
  ])
]
const IN_CELL = { x: 20, y: 20 }

for (let i = 0; i < Number(process.env.SCRATCH_N ?? 8); i++) {
  test(`pick right after create #${i}`, async ({ page }) => {
    await vaultOpen(page)
    const note = await openNewNote(page, `Scratch ${i} ${Date.now()}`, 'seed')
    await page.evaluate(() => {
      const w = window as any
      const t0 = performance.now()
      const log: string[] = (w.__t = [])
      const rec = (s: string) => log.push(`${Math.round(performance.now() - t0)} ${s}`)
      w.__rec = rec
      for (const type of ['pointerdown', 'click']) {
        document.addEventListener(
          type,
          (e) => {
            const t = e.target as Element | null
            const sw = t?.closest?.('[data-test]')
            const red = document.querySelector('[data-test="background-color-red"]')
            const r = red?.getBoundingClientRect()
            rec(
              `${type} at ${Math.round((e as MouseEvent).clientX)},${Math.round((e as MouseEvent).clientY)} on ${sw?.getAttribute('data-test') ?? t?.tagName} red@${r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : '-'}`
            )
          },
          true
        )
      }
      let lastEd: unknown = null
      const ti = w.__TAURI_INTERNALS__
      if (ti && !ti.__wrapped) {
        ti.__wrapped = true
        const oi = ti.invoke.bind(ti)
        const delay = Number(w.__ipcDelay ?? 0)
        ti.invoke = async (cmd: string, args: any, opts: any) => {
          if (!/^plugin:event|e2e_/.test(cmd)) rec(`invoke> ${cmd}`)
          const r = await oi(cmd, args, opts)
          if (w.__ipcDelay && /crdt|note|vault/.test(cmd))
            await new Promise((res) => setTimeout(res, w.__ipcDelay))
          if (!/^plugin:event|e2e_/.test(cmd)) rec(`invoke< ${cmd}`)
          return r
        }
        void delay
      }
      const ocb = ti?.transformCallback
      void ocb
      const oe = console.error.bind(console)
      console.error = (...a: unknown[]) => {
        rec(`console.error ${a.map(String).join(' ').slice(0, 200)}`)
        oe(...a)
      }
      const ow = console.warn.bind(console)
      console.warn = (...a: unknown[]) => {
        rec(`console.warn ${a.map(String).join(' ').slice(0, 200)}`)
        ow(...a)
      }
      window.addEventListener('error', (e) => rec(`onerror ${e.message}`))
      let lastTable: Element | null = null
      let lastView: unknown = null
      let lastDoc: unknown = null
      let lastSig = ''
      const tick = () => {
        const ed = w.__memryActiveEditor
        if (ed !== lastEd) rec('editor instance changed')
        lastEd = ed
        const view = ed?.prosemirrorView
        if (view !== lastView) rec(`view changed`)
        if (view && !view.__yHooked) {
          view.__yHooked = true
          const ys = view.state.plugins
            .map((pl: any) => [pl.spec?.key?.key ?? pl.key, pl.getState?.(view.state)])
            .find(([k]: any) => String(k).startsWith('y-sync'))
          const ydoc = ys?.[1]?.doc
          rec(`ysync found=${Boolean(ydoc)}`)
          for (const pl of view.state.plugins) {
            const spec = pl.spec
            if (spec?.filterTransaction) {
              const of = spec.filterTransaction
              const name = String(spec.key?.key ?? pl.key)
              spec.filterTransaction = function (tr: any, st: any) {
                const ok = of.call(this, tr, st)
                if (!ok) rec(`REFUSED by ${name} docChanged=${tr.docChanged}`)
                return ok
              }
            }
          }
          const od = view.dispatch.bind(view)
          view.dispatch = (tr: any) => {
            if (tr.docChanged) rec(`dispatch docChanged steps=${tr.steps.length}`)
            return od(tr)
          }
          rec(`editable=${view.editable}`)
          ydoc?.on('update', (u: Uint8Array, origin: any) => {
            const o =
              typeof origin === 'string' ? origin : (origin?.constructor?.name ?? String(origin))
            rec(`y update origin=${o} bytes=${u.length}`)
          })
        }
        lastView = view
        const doc = view?.state.doc
        if (doc && lastDoc && doc !== lastDoc && lastView === view) {
          let tnode: any = null
          doc.descendants((n: any) => {
            if (n.type.name === 'table') {
              tnode = n
              return false
            }
            return true
          })
          rec(`doc tx tableNodeSame=${tnode === w.__lastT} size=${doc.content.size}`)
          w.__lastT = tnode
        }
        lastDoc = doc
        const table = document.querySelector(`.bn-editor table`)
        if (table !== lastTable) rec(`table element changed (connected=${table?.isConnected})`)
        lastTable = table
        const tb = ed?.document?.find((b: any) => b.type === 'table')
        const sig = tb
          ? `${tb.id} bg10=${tb.content.rows[1]?.cells[1 - 1]?.props?.backgroundColor}`
          : 'no table'
        if (sig !== lastSig) rec(`doc ${sig}`)
        lastSig = sig
        if (ed && !ed.__wrapped) {
          ed.__wrapped = true
          const orig = ed.updateBlock.bind(ed)
          ed.updateBlock = (b: any, u: any) => {
            rec(
              `updateBlock ${typeof b === 'string' ? b : b.id} live=${ed.document.map((x: any) => x.id).join(',')}`
            )
            try {
              return orig(b, u)
            } catch (e) {
              rec(`updateBlock threw ${String(e)}`)
              throw e
            }
          }
        }
        requestAnimationFrame(tick)
      }
      tick()
    })
    await page.evaluate(
      (d) => {
        ;(window as any).__ipcDelay = d
      },
      Number(process.env.SCRATCH_IPC_DELAY ?? 0)
    )
    await setBlocks(page, TABLE_DOC)
    await page.evaluate(() => (window as any).__rec('setBlocks done'))
    await page.waitForTimeout(
      Number(process.env.SCRATCH_DELAY ?? 0) + i * Number(process.env.SCRATCH_STEP ?? 0)
    )
    await page.evaluate(() => (window as any).__rec('delay done'))
    const bodyCell = page.locator(`${NOTE_EDITOR} td`).first()
    const box = await bodyCell.boundingBox()
    if (!box) throw new Error('no box')
    await page.mouse.move(box.x + IN_CELL.x, box.y + IN_CELL.y)
    const cellHandle = page.locator('[data-memry-table-handle="cell"]').first()
    await expect(cellHandle).toBeVisible({ timeout: 10_000 })
    await cellHandle.click()
    await page.evaluate(() => (window as any).__rec('nub clicked'))
    await page.getByText('Colors', { exact: true }).first().click()
    {
      const samples = await page.evaluate(
        () =>
          new Promise<string[]>((resolve) => {
            const out: string[] = []
            const t0 = performance.now()
            const rect = (el: Element | null | undefined) => {
              const r = el?.getBoundingClientRect()
              return r
                ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`
                : '-'
            }
            let last = ''
            const step = () => {
              const red = document.querySelector('[data-test="background-color-red"]')
              const popups = [
                ...document.querySelectorAll(
                  '[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"]'
                )
              ]
              const scrolled = [...document.querySelectorAll('*')]
                .filter((el) => el.scrollTop !== 0)
                .map(
                  (el) => `${el.tagName}.${el.getAttribute('class')?.split(' ')[0]}=${el.scrollTop}`
                )
              const table = document.querySelector('.bn-editor table')
              const line = `red=${rect(red)} popups=${popups.map((p) => `${p.getAttribute('data-slot')?.slice(-11)}@${rect(p)}${p.hasAttribute('data-starting-style') ? 'S' : ''}${p.hasAttribute('data-open') ? 'O' : ''}`).join('|')} table=${rect(table)} scroll=${scrolled.join(',')} active=${document.activeElement?.tagName}.${document.activeElement?.getAttribute('data-test') ?? ''} vh=${innerHeight}`
              if (line !== last) out.push(`${Math.round(performance.now() - t0)} ${line}`)
              last = line
              if (performance.now() - t0 < 1500) requestAnimationFrame(step)
              else resolve(out)
            }
            step()
          })
      )
      console.log(`SAMPLES\n${samples.join('\n')}`)
    }
    await page.evaluate(() => (window as any).__rec('colors clicked'))
    await page.locator('[data-test="background-color-red"]').first().click()
    await page.evaluate(() => (window as any).__rec('red clicked'))
    await page.waitForTimeout(4000)
    const t = await page.evaluate(() => (window as any).__t as string[])
    const body = (await noteBody(page, note.id)) ?? ''
    if (!body.includes('table-colors') || i === 0)
      console.log(
        `SCRATCH#${i} marker=${body.includes('table-colors')} body=${JSON.stringify(body.slice(0, 300))}\n${t.join('\n')}`
      )
  })
}
