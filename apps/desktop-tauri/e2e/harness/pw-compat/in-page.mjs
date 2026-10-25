// The code that runs inside the app's webview. `memryPwInstall` is serialized with
// `Function.prototype.toString` and installed as `window.__memryPw`, so it must stay one
// self-contained function with no references to module scope. Plain JavaScript on purpose: the
// bundler of the test runner may rewrite TypeScript functions with helpers the page lacks. The
// unit tests run it in jsdom.

/** @param {Window & typeof globalThis} win */
export function memryPwInstall(win) {
  const doc = win.document

  const norm = (text) => (text == null ? '' : String(text)).replace(/\s+/g, ' ').trim()

  /** Substring match ignores case; `exact` compares the normalized strings; a regex is a regex. */
  function matches(haystack, matcher, exact) {
    if (matcher && typeof matcher === 'object' && matcher.regex) {
      return new RegExp(matcher.regex.source, matcher.regex.flags).test(haystack)
    }
    if (exact) return norm(haystack) === norm(matcher)
    return norm(haystack).toLowerCase().includes(norm(matcher).toLowerCase())
  }

  const textOf = (el) => el.textContent || ''

  // ---- roles and names -----------------------------------------------------------------------

  const INPUT_ROLES = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    number: 'spinbutton',
    search: 'searchbox',
    email: 'textbox',
    tel: 'textbox',
    text: 'textbox',
    url: 'textbox',
    password: 'textbox',
    '': 'textbox'
  }

  const TAG_ROLES = {
    button: 'button',
    textarea: 'textbox',
    li: 'listitem',
    ul: 'list',
    ol: 'list',
    nav: 'navigation',
    main: 'main',
    table: 'table',
    tr: 'row',
    td: 'cell',
    th: 'columnheader',
    dialog: 'dialog',
    progress: 'progressbar',
    article: 'article',
    aside: 'complementary',
    hr: 'separator',
    option: 'option',
    form: 'form'
  }

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0]
    if (explicit) return explicit.toLowerCase()
    const tag = el.tagName.toLowerCase()
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : null
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return el.getAttribute('alt') === '' ? 'presentation' : 'img'
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (type === 'hidden') return null
      if (el.hasAttribute('list') && ['', 'text', 'search', 'email', 'tel', 'url'].includes(type)) {
        return 'combobox'
      }
      return INPUT_ROLES[type] || 'textbox'
    }
    return TAG_ROLES[tag] || null
  }

  const NAME_FROM_CONTENT = new Set([
    'button',
    'link',
    'heading',
    'listitem',
    'option',
    'cell',
    'columnheader',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'checkbox',
    'radio',
    'switch',
    'row',
    'treeitem',
    'img'
  ])

  function labelTexts(el) {
    const texts = []
    if (el.id) {
      for (const label of doc.querySelectorAll('label')) {
        if (label.getAttribute('for') === el.id) texts.push(textOf(label))
      }
    }
    const wrapping = el.closest ? el.closest('label') : null
    if (wrapping) texts.push(textOf(wrapping))
    return texts
  }

  function nameOf(el) {
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id))
        .filter(Boolean)
        .map(textOf)
        .join(' ')
      if (norm(text)) return norm(text)
    }
    const aria = el.getAttribute('aria-label')
    if (norm(aria)) return norm(aria)
    const tag = el.tagName.toLowerCase()
    if (['input', 'textarea', 'select'].includes(tag)) {
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) {
        const value = el.getAttribute('value')
        if (norm(value)) return norm(value)
        if (type === 'submit') return 'Submit'
        if (type === 'reset') return 'Reset'
      }
      const labels = labelTexts(el).join(' ')
      if (norm(labels)) return norm(labels)
    }
    const alt = el.getAttribute('alt')
    if (norm(alt) && (tag === 'img' || tag === 'area' || tag === 'input')) return norm(alt)
    if (NAME_FROM_CONTENT.has(roleOf(el) || '') && norm(textOf(el))) return norm(textOf(el))
    const title = el.getAttribute('title')
    if (norm(title)) return norm(title)
    const placeholder = el.getAttribute('placeholder')
    if (norm(placeholder)) return norm(placeholder)
    return ''
  }

  // ---- visibility ----------------------------------------------------------------------------

  /** Playwright's visible: a non-empty box and no `visibility: hidden`. */
  function isVisible(el) {
    const style = win.getComputedStyle(el)
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (style.display === 'none') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  /** Not rendered at all: `display: none` anywhere up the tree, `hidden`, or `aria-hidden`. */
  function isExcludedFromRoles(el) {
    for (let node = el; node?.nodeType === 1; node = node.parentElement) {
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return true
      if (win.getComputedStyle(node).display === 'none') return true
    }
    return false
  }

  function isDisabled(el) {
    if (el.closest?.('[aria-disabled="true"]')) return true
    if ('disabled' in el && el.disabled) return true
    const fieldset = el.closest ? el.closest('fieldset[disabled]') : null
    return !!fieldset
  }

  // ---- queries -------------------------------------------------------------------------------

  function inDocumentOrder(elements) {
    const unique = [...new Set(elements)]
    return unique.toSorted((a, b) => {
      if (a === b) return 0
      const position = a.compareDocumentPosition(b)
      return position & 4 ? -1 : 1
    })
  }

  const descendants = (contexts) =>
    inDocumentOrder(contexts.flatMap((ctx) => [...ctx.querySelectorAll('*')]))

  function deepestTextMatches(candidates, matcher, exact) {
    const hits = candidates.filter((el) => matches(textOf(el), matcher, exact))
    const set = new Set(hits)
    return hits.filter((el) => ![...el.children].some((child) => set.has(child)))
  }

  /** Top-level commas of a selector list; commas inside quotes, brackets and parens stay. */
  function splitSelectorList(selector) {
    const parts = []
    let depth = 0
    let quote = ''
    let start = 0
    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i]
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth--
      else if (ch === ',' && depth === 0) {
        parts.push(selector.slice(start, i))
        start = i + 1
      }
    }
    parts.push(selector.slice(start))
    return parts.map((part) => part.trim()).filter(Boolean)
  }

  const TEXT_PSEUDO = /:(has-text|text)\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)/g

  /**
   * `querySelectorAll` plus Playwright's `:has-text("x")` (the element's text contains x,
   * ignoring case) and `:text("x")` (the smallest element whose text contains x).
   */
  function queryCss(ctx, selector) {
    const found = []
    for (const part of splitSelectorList(selector)) {
      const texts = []
      const plain = part.replace(TEXT_PSEUDO, (_all, kind, quoted) => {
        texts.push({
          kind,
          text: JSON.parse(quoted.startsWith("'") ? JSON.stringify(quoted.slice(1, -1)) : quoted)
        })
        return ''
      })
      let hits = [...ctx.querySelectorAll(plain || '*')]
      for (const { kind, text } of texts) {
        hits = hits.filter((el) => matches(textOf(el), text, false))
        if (kind === 'text') {
          const set = new Set(hits)
          hits = hits.filter((el) => ![...el.children].some((child) => set.has(child)))
        }
      }
      found.push(...hits)
    }
    return found
  }

  function applyStep(contexts, step) {
    switch (step.kind) {
      case 'css':
        return inDocumentOrder(contexts.flatMap((ctx) => queryCss(ctx, step.selector)))
      case 'testid':
        return descendants(contexts).filter((el) => el.getAttribute('data-testid') === step.id)
      case 'role':
        return descendants(contexts).filter((el) => {
          if (roleOf(el) !== step.role.toLowerCase()) return false
          if (isExcludedFromRoles(el)) return false
          return step.name === undefined || matches(nameOf(el), step.name, step.exact)
        })
      case 'text': {
        const all = descendants(contexts).filter(
          (el) =>
            !['script', 'style', 'head', 'title', 'meta', 'link'].includes(el.tagName.toLowerCase())
        )
        return deepestTextMatches(all, step.text, step.exact)
      }
      case 'label':
        return descendants(contexts).filter((el) => {
          if (
            matches(el.getAttribute('aria-label') || '', step.text, step.exact) &&
            el.hasAttribute('aria-label')
          ) {
            return true
          }
          if (!['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())) return false
          return labelTexts(el).some((text) => matches(text, step.text, step.exact))
        })
      case 'placeholder':
        return descendants(contexts).filter(
          (el) =>
            el.hasAttribute('placeholder') &&
            matches(el.getAttribute('placeholder'), step.text, step.exact)
        )
      case 'filter':
        return contexts.filter((el) => {
          if (step.hasText !== undefined && !matches(textOf(el), step.hasText, false)) return false
          if (step.hasNotText !== undefined && matches(textOf(el), step.hasNotText, false))
            return false
          return true
        })
      case 'nth': {
        const element =
          step.index < 0 ? contexts[contexts.length + step.index] : contexts[step.index]
        return element ? [element] : []
      }
      default:
        throw new Error('unknown locator step ' + step.kind)
    }
  }

  /** The elements a locator spec resolves to, in document order. */
  function queryAll(spec) {
    let current = [doc]
    for (const step of spec.steps) current = applyStep(current, step)
    return current[0] === doc && spec.steps.length === 0 ? [doc.documentElement] : current
  }

  // ---- inspection ----------------------------------------------------------------------------

  function boxOf(el) {
    const rect = el.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }

  function isChecked(el) {
    if ('checked' in el && (el.type === 'checkbox' || el.type === 'radio')) return !!el.checked
    return el.getAttribute('aria-checked') === 'true'
  }

  function valueOf(el, kind, arg) {
    switch (kind) {
      case 'visible':
        return isVisible(el)
      case 'enabled':
        return !isDisabled(el)
      case 'checked':
        return isChecked(el)
      case 'focused':
        return doc.activeElement === el
      case 'text':
        return el.textContent
      case 'innerText':
        return el.innerText === undefined ? el.textContent : el.innerText
      case 'value':
        return 'value' in el ? el.value : null
      case 'attr':
        return el.getAttribute(arg)
      case 'class':
        return el.getAttribute('class') || ''
      case 'css':
        return win.getComputedStyle(el).getPropertyValue(arg)
      case 'box':
        return boxOf(el)
      case 'editable':
        return !isDisabled(el) && !el.readOnly
      default:
        throw new Error('unknown inspect kind ' + kind)
    }
  }

  /**
   * `{ count, value }`; `value` is read from the only match and is `undefined` when the locator
   * matches zero or several elements, so callers can tell a missing element from a false value.
   */
  function inspect(spec, kind, arg) {
    const elements = queryAll(spec)
    if (kind === 'count') return { count: elements.length }
    if (kind === 'texts')
      return { count: elements.length, value: elements.map((el) => el.textContent) }
    if (elements.length !== 1) return { count: elements.length }
    const value = valueOf(elements[0], kind, arg)
    return { count: 1, value: value === undefined ? null : value }
  }

  /**
   * The state an action waits for. `scroll` brings the element into view first. `hit` is true
   * when the element is what sits at the centre of its box, which rules out an overlay.
   */
  function target(spec, scroll) {
    const elements = queryAll(spec)
    if (elements.length !== 1) return { count: elements.length }
    const el = elements[0]
    if (scroll && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' })
    const box = boxOf(el)
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const top = doc.elementFromPoint(cx, cy)
    return {
      count: 1,
      visible: isVisible(el),
      enabled: !isDisabled(el),
      hit: !!top && (top === el || el.contains(top)),
      box,
      x: cx,
      y: cy
    }
  }

  // ---- actions that run in the page ----------------------------------------------------------

  const nativeSetter = (el) => {
    const proto =
      el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype
    return Object.getOwnPropertyDescriptor(proto, 'value').set
  }

  /** Playwright's fill: focus, replace the whole value, fire `input` (and `change` is left to blur). */
  function fill(spec, text) {
    const elements = queryAll(spec)
    if (elements.length !== 1) return { count: elements.length }
    const el = elements[0]
    el.focus()
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      nativeSetter(el).call(el, text)
      el.dispatchEvent(new win.Event('input', { bubbles: true }))
      return { count: 1, done: true }
    }
    if (el.isContentEditable) {
      const selection = win.getSelection()
      selection.selectAllChildren(el)
      if (text === '') doc.execCommand('delete')
      else doc.execCommand('insertText', false, text)
      return { count: 1, done: true }
    }
    return { count: 1, done: false, error: 'element is not an input, textarea or contenteditable' }
  }

  function focus(spec) {
    const elements = queryAll(spec)
    if (elements.length !== 1) return { count: elements.length }
    elements[0].focus()
    return { count: 1, done: true }
  }

  function blur(spec) {
    const elements = queryAll(spec)
    if (elements.length !== 1) return { count: elements.length }
    elements[0].blur()
    return { count: 1, done: true }
  }

  function scrollIntoView(spec) {
    const elements = queryAll(spec)
    if (elements.length !== 1) return { count: elements.length }
    elements[0].scrollIntoView({ block: 'center', inline: 'center' })
    return { count: 1, done: true }
  }

  const frame = () =>
    new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (!done) {
          done = true
          resolve(undefined)
        }
      }
      win.requestAnimationFrame(finish)
      // A window in the background may not paint; do not wait for it forever.
      win.setTimeout(finish, 50)
    })

  const sameBox = (a, b) =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

  /**
   * Playwright's actionability: `target` sampled on three consecutive frames. `stable` is true
   * when the box did not move, which lets the caller act after one round trip.
   */
  async function settle(spec, scroll) {
    const first = target(spec, scroll)
    if (first.count !== 1 || !first.visible) return first
    await frame()
    const second = target(spec, false)
    if (second.count !== 1 || !sameBox(first.box, second.box)) return { ...second, stable: false }
    await frame()
    const third = target(spec, false)
    return { ...third, stable: third.count === 1 && sameBox(second.box, third.box) }
  }

  // ---- what a driver may leave out of a click -----------------------------------------------

  const FOCUSABLE =
    'input, textarea, select, button, a[href], [tabindex], [contenteditable=""], [contenteditable="true"]'
  let seen = {}
  let watching = null

  /** Starts recording which events the driver itself dispatches for the next input. */
  function watch() {
    seen = {}
    if (watching) return true
    watching = (event) => {
      seen[event.type] = true
      if (event.type === 'mousedown' && event.defaultPrevented) seen.prevented = true
    }
    for (const type of [
      'pointerdown',
      'mousedown',
      'dblclick',
      'contextmenu',
      'mouseover',
      'pointerover'
    ]) {
      doc.addEventListener(type, watching, true)
    }
    return true
  }

  function mouseInit(x, y, button, detail, buttons) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      clientX: x,
      clientY: y,
      button,
      buttons,
      detail
    }
  }

  /**
   * Some embedded drivers (macOS WKWebView) dispatch synthetic `mousedown`, `mouseup` and `click`
   * only. Add what a real click does and was not seen: pointer events, focus, `dblclick` and
   * `contextmenu`. Idempotent against drivers that already did it.
   */
  function fixup(x, y, button, clickCount) {
    const el = doc.elementFromPoint(x, y)
    if (!el) return false
    const buttons = button === 0 ? 1 : button === 2 ? 2 : 4
    if (!seen.pointerdown && typeof win.PointerEvent === 'function') {
      const init = {
        ...mouseInit(x, y, button, 0, buttons),
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      }
      el.dispatchEvent(new win.PointerEvent('pointerdown', init))
      el.dispatchEvent(new win.PointerEvent('pointerup', { ...init, buttons: 0 }))
    }
    if (button === 0 && !seen.prevented) {
      const focusable = el.closest(FOCUSABLE)
      if (focusable) {
        if (doc.activeElement !== focusable) focusable.focus()
      } else if (doc.activeElement && doc.activeElement !== doc.body) {
        doc.activeElement.blur()
      }
    }
    if (clickCount >= 2 && !seen.dblclick) {
      el.dispatchEvent(new win.MouseEvent('dblclick', mouseInit(x, y, button, 2, 0)))
    }
    if (button === 2 && !seen.contextmenu) {
      el.dispatchEvent(new win.MouseEvent('contextmenu', mouseInit(x, y, button, 0, 0)))
    }
    return true
  }

  let hovered = null

  /** Adds the enter and over events a driver left out of a pointer move. */
  function fixupHover(x, y) {
    const el = doc.elementFromPoint(x, y)
    if (!el || el === hovered || seen.mouseover) return false
    hovered = el
    const init = mouseInit(x, y, 0, 0, 0)
    if (typeof win.PointerEvent === 'function') {
      el.dispatchEvent(
        new win.PointerEvent('pointerover', {
          ...init,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true
        })
      )
    }
    el.dispatchEvent(new win.MouseEvent('mouseover', init))
    return true
  }

  win.__memryPw = {
    queryAll,
    inspect,
    target,
    settle,
    watch,
    fixup,
    fixupHover,
    fill,
    focus,
    blur,
    scrollIntoView,
    roleOf,
    nameOf
  }
  return win.__memryPw
}

/** The script that installs the helpers once per page load. */
export const INSTALL_SCRIPT = `if (!window.__memryPw) { (${memryPwInstall.toString()})(window); }`
