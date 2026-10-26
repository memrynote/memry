import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { JSDOM } from 'jsdom'

import { asScript, snapshotPage } from './lib/page-scripts.mjs'

/** Runs the snapshot function inside a jsdom page, as the driver runs it in the app. */
function snapshotIn(html, maxLines = 4000) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  return {
    dom,
    result: JSON.parse(JSON.stringify(dom.window.eval(`(${snapshotPage.toString()})(${maxLines})`)))
  }
}

describe('snapshotPage', () => {
  it('outlines roles, names, values and states, and stamps refs', () => {
    const { dom, result } = snapshotIn(`
      <button aria-label="Save" disabled>x</button>
      <a href="/home">Home</a><a>no href</a>
      <label for="t">Title</label><input id="t" value="Hello">
      <input type="checkbox" aria-label="Done" checked>
      <h2>Tasks</h2>
      <ul><li role="option" aria-selected="true">One</li></ul>
      <div hidden><button>hidden</button></div>
      <div style="display:none"><button>none</button></div>
      <div role="button" aria-expanded="true">Menu</div>`)
    assert.deepEqual(result.lines, [
      '- button "Save" [disabled] [ref=e1]',
      '- link "Home" [ref=e2]',
      '- textbox "Title" value="Hello" [ref=e3]',
      '- checkbox "Done" [checked] [ref=e4]',
      '- heading "Tasks" [ref=e5]',
      '- option "One" [selected] [ref=e6]',
      '- button "Menu" [expanded] [ref=e7]'
    ])
    assert.equal(result.truncated, false)
    assert.equal(dom.window.document.querySelector('[data-agent-ref="e2"]').textContent, 'Home')
  })

  it('clears the stamps of the previous snapshot', () => {
    const dom = new JSDOM('<button>A</button><button>B</button>', { runScripts: 'outside-only' })
    const run = () => dom.window.eval(`(${snapshotPage.toString()})(4000)`)
    run()
    dom.window.document.querySelectorAll('button')[0].remove()
    run()
    assert.equal(dom.window.document.querySelectorAll('[data-agent-ref]').length, 1)
    assert.equal(dom.window.document.querySelector('[data-agent-ref="e1"]').textContent, 'B')
  })

  it('wraps the function as a driver script body', () => {
    assert.match(
      asScript(snapshotPage),
      /^return \(function snapshotPage[\s\S]*\)\.apply\(null, arguments\);$/
    )
  })

  it('caps the outline and says so', () => {
    const { result } = snapshotIn('<button>a</button><button>b</button><button>c</button>', 2)
    assert.equal(result.lines.length, 2)
    assert.equal(result.total, 3)
    assert.equal(result.truncated, true)
  })

  it('snapshots 2000 visible elements in under a second', () => {
    const items = Array.from(
      { length: 2000 },
      (_, i) => `<li><button>Item ${i}</button></li>`
    ).join('')
    const dom = new JSDOM(`<ul>${items}</ul>`, { runScripts: 'outside-only' })
    // Every engine the app runs on ships `checkVisibility`; jsdom does not, so give it the cheap
    // equivalent. The `getComputedStyle` fallback is covered by the outline test above.
    dom.window.HTMLElement.prototype.checkVisibility = function () {
      return !this.hidden
    }
    const started = performance.now()
    const result = dom.window.eval(`(${snapshotPage.toString()})(4000)`)
    const elapsed = performance.now() - started
    assert.equal(result.total, 4000)
    assert.ok(elapsed < 1000, `snapshot took ${Math.round(elapsed)} ms`)
  })
})
