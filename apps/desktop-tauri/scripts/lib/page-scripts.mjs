// Scripts that run inside the app's page through WebDriver `execute/sync` and `execute/async`.
// Each is a plain function so a test can run it in jsdom; `asScript` wraps one for the driver.

/** Wraps a function as a WebDriver script body that calls it with the script arguments. */
export function asScript(fn) {
  return `return (${fn.toString()}).apply(null, arguments);`
}

/** `execute/async` body: calls an `e2e_*` command and answers `{ ok, value | error }`. */
export const INVOKE_SCRIPT = `
  const [name, args, done] = arguments;
  const tauri = window.__TAURI__;
  if (!tauri) return done({ ok: false, error: 'window.__TAURI__ is missing; is this the e2e build?' });
  tauri.core.invoke(name, args).then(
    (value) => done({ ok: true, value: value === undefined ? null : value }),
    (error) => done({ ok: false, error: String((error && error.message) || error) })
  );
`

/**
 * `execute/async` body that evaluates JavaScript and awaits a promise. The page's CSP forbids
 * `eval`, but the driver runs the script itself, so the code is pasted into the body instead.
 * `expression` mode returns the value of one expression (a function is called, as the
 * Playwright MCP does); `body` mode runs statements and returns what they `return`.
 *
 * @param {string} code
 * @param {'expression' | 'body'} mode
 */
export function evalScript(code, mode = 'expression') {
  const run = mode === 'expression' ? `return (\n${code}\n);` : code
  return `
  const done = arguments[arguments.length - 1];
  Promise.resolve()
    .then(async () => {
      const result = await (async () => { ${run} })();
      return typeof result === 'function' ? await result() : result;
    })
    .then(
      (value) => {
        let plain = value;
        if (typeof value !== 'string') {
          try { plain = value === undefined ? null : JSON.parse(JSON.stringify(value)); }
          catch { plain = String(value); }
        }
        done({ ok: true, value: plain });
      },
      (error) => done({ ok: false, error: error && error.message ? (error.name || 'Error') + ': ' + error.message : String(error) })
    );
`
}

/**
 * Runs JavaScript in the page through `execute/async`. A syntax error in expression mode (the
 * code is statements) runs it again as a function body.
 *
 * @param {{ executeAsync(id: string, script: string, args?: unknown[]): Promise<any> }} client
 * @param {string} sessionId
 * @param {string} code
 * @returns {Promise<{ ok: boolean, value?: unknown, error?: string }>}
 */
export async function evaluateInPage(client, sessionId, code) {
  try {
    return await client.executeAsync(sessionId, evalScript(code, 'expression'), [])
  } catch (error) {
    if (!/SyntaxError|Unexpected|Unterminated/i.test(String(error))) throw error
    return client.executeAsync(sessionId, evalScript(code, 'body'), [])
  }
}

/**
 * Walks the visible DOM and returns an outline of the elements that have a role. Each outline
 * line carries a reference `e<n>`, stamped on the element as `data-agent-ref`; the stamps of the
 * previous snapshot are cleared first. Runs in the page, so it uses nothing from this module.
 *
 * @param {number} maxLines
 * @returns {{ lines: string[], total: number, truncated: boolean }}
 */
export function snapshotPage(maxLines) {
  const IMPLICIT = {
    button: 'button',
    a: 'link',
    textarea: 'textbox',
    select: 'combobox',
    li: 'listitem',
    img: 'img',
    table: 'table',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading'
  }
  const INPUT_ROLES = {
    checkbox: 'checkbox',
    radio: 'radio',
    button: 'button',
    submit: 'button',
    reset: 'button',
    range: 'slider',
    search: 'searchbox'
  }
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK'])
  const NAME_MAX = 100

  for (const stale of document.querySelectorAll('[data-agent-ref]'))
    stale.removeAttribute('data-agent-ref')

  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.split(/\s+/)[0]
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null
    if (tag === 'input')
      return INPUT_ROLES[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox'
    return IMPLICIT[tag] || null
  }

  const clean = (text) => text.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)

  const nameOf = (el) => {
    const label = el.getAttribute('aria-label')
    if (label) return clean(label)
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
      if (clean(text)) return clean(text)
    }
    if (el.id && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
      const target = document.querySelector(`label[for="${el.id.replace(/"/g, '\\"')}"]`)
      if (target && clean(target.textContent || '')) return clean(target.textContent || '')
    }
    for (const attr of ['placeholder', 'alt', 'title']) {
      const value = el.getAttribute(attr)
      if (value) return clean(value)
    }
    return clean(el.textContent || '')
  }

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the function body is serialized into the page, so every helper lives inside it
  const hidden = (el) => {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return 'prune'
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })
        ? false
        : 'prune'
    }
    const style = getComputedStyle(el)
    if (style.display === 'none') return 'prune'
    return style.visibility === 'hidden' ? 'skip' : false
  }

  const lines = []
  let total = 0

  const visit = (el, depth) => {
    if (SKIP.has(el.tagName)) return
    const state = hidden(el)
    if (state === 'prune') return
    let childDepth = depth
    const role = state === 'skip' ? null : roleOf(el)
    if (role) {
      total += 1
      const ref = `e${total}`
      el.setAttribute('data-agent-ref', ref)
      if (lines.length < maxLines) {
        const name = nameOf(el)
        const value =
          'value' in el &&
          typeof el.value === 'string' &&
          el.value !== '' &&
          !['button', 'img', 'checkbox', 'radio'].includes(role)
            ? el.value
            : ''
        const flags = []
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') flags.push('disabled')
        if (el.checked || el.getAttribute('aria-checked') === 'true') flags.push('checked')
        if (el.getAttribute('aria-expanded') === 'true') flags.push('expanded')
        if (el.getAttribute('aria-selected') === 'true' || el.selected) flags.push('selected')
        lines.push(
          `${'  '.repeat(depth)}- ${role}${name ? ` "${name}"` : ''}${value ? ` value="${clean(value)}"` : ''}${flags.map((f) => ` [${f}]`).join('')} [ref=${ref}]`
        )
      }
      childDepth = depth + 1
    }
    for (const child of el.children) visit(child, childDepth)
  }

  if (document.body) visit(document.body, 0)
  return { lines, total, truncated: total > lines.length }
}
