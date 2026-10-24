import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'

import { memryPwInstall, INSTALL_SCRIPT } from './pw-compat/in-page.mjs'
import { keyToCodepoint, parseKeyCombo, pressActions, typeActions } from './pw-compat/keys.ts'
import { describeSpec, rootSpec, specs } from './pw-compat/selector-spec.ts'

// ---- keys -------------------------------------------------------------------------------------

test('named keys map to W3C codepoints', () => {
  assert.equal(keyToCodepoint('Enter'), '\uE007')
  assert.equal(keyToCodepoint('Escape'), '\uE00C')
  assert.equal(keyToCodepoint('ArrowLeft'), '\uE012')
  assert.equal(keyToCodepoint('Backspace'), '\uE003')
  assert.equal(keyToCodepoint('F5'), '\uE035')
  assert.equal(keyToCodepoint('Meta'), '\uE03D')
  assert.equal(keyToCodepoint('a'), 'a')
  assert.equal(keyToCodepoint('KeyK'), 'k')
  assert.equal(keyToCodepoint('Digit7'), '7')
  assert.throws(() => keyToCodepoint('NoSuchKey'), /Unknown key/)
})

test('ControlOrMeta follows the platform', () => {
  assert.equal(keyToCodepoint('ControlOrMeta', 'darwin'), '\uE03D')
  assert.equal(keyToCodepoint('ControlOrMeta', 'win32'), '\uE009')
  assert.equal(keyToCodepoint('ControlOrMeta', 'linux'), '\uE009')
})

test('key combos split on plus, and a lone plus is the plus key', () => {
  assert.deepEqual(parseKeyCombo('Meta+Shift+a', 'darwin'), ['\uE03D', '\uE008', 'a'])
  assert.deepEqual(parseKeyCombo('+'), ['+'])
  assert.deepEqual(parseKeyCombo('Control++'), ['\uE009', '+'])
  assert.deepEqual(parseKeyCombo('Enter'), ['\uE007'])
})

test('press holds modifiers around the key and releases them in reverse', () => {
  assert.deepEqual(pressActions('Control+Shift+Enter'), [
    { type: 'keyDown', value: '\uE009' },
    { type: 'keyDown', value: '\uE008' },
    { type: 'keyDown', value: '\uE007' },
    { type: 'keyUp', value: '\uE007' },
    { type: 'keyUp', value: '\uE008' },
    { type: 'keyUp', value: '\uE009' }
  ])
})

test('typing sends one down and up per character and newline is Enter', () => {
  assert.deepEqual(typeActions('a\n'), [
    { type: 'keyDown', value: 'a' },
    { type: 'keyUp', value: 'a' },
    { type: 'keyDown', value: '\uE007' },
    { type: 'keyUp', value: '\uE007' }
  ])
})

// ---- selector specs ---------------------------------------------------------------------------

test('locator chains build an ordered, serializable spec', () => {
  const spec = specs.nth(
    specs.filter(specs.role(specs.css(rootSpec, '.list'), 'button', { name: /save/i }), {
      hasText: 'Note'
    }),
    0
  )
  const roundTripped = JSON.parse(JSON.stringify(spec))
  assert.deepEqual(
    roundTripped.steps.map((step) => step.kind),
    ['css', 'role', 'filter', 'nth']
  )
  assert.deepEqual(roundTripped.steps[1].name, { regex: { source: 'save', flags: 'i' } })
  assert.equal(roundTripped.steps[2].hasText, 'Note')
  assert.equal(rootSpec.steps.length, 0, 'building a spec never mutates its parent')
})

test('specs read like Playwright locators in errors', () => {
  const spec = specs.nth(specs.testId(specs.css(rootSpec, 'main'), 'save'), -1)
  assert.equal(describeSpec(spec), 'locator("main").getByTestId("save").last()')
  assert.equal(describeSpec(rootSpec), 'page')
})

// ---- in-page resolver (jsdom) -----------------------------------------------------------------

function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`)
  const pw = memryPwInstall(dom.window)
  return { dom, pw, q: (steps) => pw.queryAll({ steps }) }
}

test('implicit roles and accessible names', () => {
  const { dom, pw } = page(`
    <button id="b1">  Save   note </button>
    <button id="b2" aria-label="Close dialog">x</button>
    <a id="a1" href="/x">Docs</a><a id="a2">no href</a>
    <label for="i1">Title</label><input id="i1">
    <input id="i2" type="checkbox" placeholder="ignored">
    <input id="i3" placeholder="Search notes">
    <h2 id="h">Heading</h2><img id="img" alt="Logo"><ul><li id="li">Item</li></ul>
    <span id="lb1">Named by</span><div id="lb" role="region" aria-labelledby="lb1"></div>`)
  const get = (id) => dom.window.document.getElementById(id)

  assert.equal(pw.roleOf(get('b1')), 'button')
  assert.equal(pw.nameOf(get('b1')), 'Save note')
  assert.equal(pw.nameOf(get('b2')), 'Close dialog')
  assert.equal(pw.roleOf(get('a1')), 'link')
  assert.equal(pw.roleOf(get('a2')), null)
  assert.equal(pw.roleOf(get('i1')), 'textbox')
  assert.equal(pw.nameOf(get('i1')), 'Title')
  assert.equal(pw.roleOf(get('i2')), 'checkbox')
  assert.equal(pw.nameOf(get('i3')), 'Search notes')
  assert.equal(pw.roleOf(get('h')), 'heading')
  assert.equal(pw.roleOf(get('img')), 'img')
  assert.equal(pw.nameOf(get('img')), 'Logo')
  assert.equal(pw.roleOf(get('li')), 'listitem')
  assert.equal(pw.nameOf(get('lb')), 'Named by')
})

test('getByRole filters by name: substring ignores case, exact does not', () => {
  const { q } = page('<button>Save note</button><button>Save</button><button>Cancel</button>')
  assert.equal(q([{ kind: 'role', role: 'button', name: 'save' }]).length, 2)
  assert.equal(q([{ kind: 'role', role: 'button', name: 'Save', exact: true }]).length, 1)
  assert.equal(
    q([{ kind: 'role', role: 'button', name: { regex: { source: '^can', flags: 'i' } } }]).length,
    1
  )
})

test('getByRole skips hidden and aria-hidden subtrees', () => {
  const { q } = page(
    '<button>Shown</button><div hidden><button>Hidden</button></div><div aria-hidden="true"><button>Aria</button></div>'
  )
  assert.equal(q([{ kind: 'role', role: 'button' }]).length, 1)
})

test('css, testid, text, label, placeholder and chaining resolve in document order', () => {
  const { q, dom } = page(`
    <div class="row"><span data-testid="t">A</span></div>
    <div class="row"><span data-testid="t">B</span><p>Hello <b>big</b> world</p></div>
    <label>Name <input id="n"></label><input placeholder="Find…">`)

  assert.deepEqual(
    q([{ kind: 'testid', id: 't' }]).map((el) => el.textContent),
    ['A', 'B']
  )
  assert.equal(
    q([
      { kind: 'css', selector: '.row' },
      { kind: 'testid', id: 't' },
      { kind: 'nth', index: -1 }
    ])[0].textContent,
    'B'
  )
  const world = q([{ kind: 'text', text: 'big' }])
  assert.equal(world.length, 1)
  assert.equal(world[0].tagName, 'B', 'the smallest element that holds the text')
  assert.equal(q([{ kind: 'label', text: 'name' }])[0], dom.window.document.getElementById('n'))
  assert.equal(q([{ kind: 'placeholder', text: 'find' }]).length, 1)
  assert.equal(
    q([
      { kind: 'css', selector: '.row' },
      { kind: 'filter', hasText: 'b' }
    ]).length,
    1
  )
  assert.equal(
    q([
      { kind: 'css', selector: '.nothing' },
      { kind: 'nth', index: 0 }
    ]).length,
    0
  )
})

test('css supports :has-text and :text like Playwright, case-insensitively', () => {
  const { q } = page(`
    <button id="a">Add Task</button><button id="b">Other</button>
    <div id="d" role="dialog">Add Task <span id="s">now</span></div>
    <a id="l1" href="#">Foo, bar</a>`)
  assert.deepEqual(
    q([{ kind: 'css', selector: 'button:has-text("add task")' }]).map((el) => el.id),
    ['a']
  )
  assert.deepEqual(
    q([{ kind: 'css', selector: '[role="dialog"]:has-text("Add Task")' }]).map((el) => el.id),
    ['d']
  )
  assert.deepEqual(
    q([{ kind: 'css', selector: "span:text('NOW'), #b" }]).map((el) => el.id),
    ['b', 's']
  )
  assert.deepEqual(
    q([{ kind: 'css', selector: 'a:has-text("Foo, bar")' }]).map((el) => el.id),
    ['l1']
  )
})

test('inspect reports counts and reads only a single match', () => {
  const { pw } = page(
    '<input id="a" value="x"><input id="b" type="checkbox" checked><input id="c" disabled>'
  )
  assert.deepEqual(pw.inspect({ steps: [{ kind: 'css', selector: 'input' }] }, 'count'), {
    count: 3
  })
  assert.deepEqual(pw.inspect({ steps: [{ kind: 'css', selector: 'input' }] }, 'value'), {
    count: 3
  })
  assert.deepEqual(pw.inspect({ steps: [{ kind: 'css', selector: '#a' }] }, 'value'), {
    count: 1,
    value: 'x'
  })
  assert.equal(pw.inspect({ steps: [{ kind: 'css', selector: '#b' }] }, 'checked').value, true)
  assert.equal(pw.inspect({ steps: [{ kind: 'css', selector: '#c' }] }, 'enabled').value, false)
  assert.deepEqual(pw.inspect({ steps: [{ kind: 'css', selector: '#zzz' }] }, 'value'), {
    count: 0
  })
})

test('the install script is self-contained', () => {
  const dom = new JSDOM('<!doctype html><body><i id="x"></i></body>', {
    runScripts: 'outside-only'
  })
  dom.window.eval(INSTALL_SCRIPT)
  assert.equal(typeof dom.window.__memryPw.queryAll, 'function')
  assert.equal(
    dom.window.__memryPw.queryAll({ steps: [{ kind: 'css', selector: '#x' }] }).length,
    1
  )
})
