/* oxlint-disable typescript/no-base-to-string -- linkedom ships no types; Document#toString is its serializer */
// Tree-editing scenarios: a page, a list of operations, and the document linkedom 0.18.12 ends
// up with. The Rust port replays the same operations.
import { parseHTML } from 'linkedom'

export const scenarios = [
  {
    name: 'remove-and-replace',
    html: '<div id="a"><p>one</p><p>two</p><p>three</p></div>',
    ops: [
      { op: 'remove', sel: 'p:nth-child(2)' },
      { op: 'replaceWith', sel: 'p', html: '<h2>new</h2> tail <!-- c -->' },
      { op: 'text', sel: '#a' }
    ]
  },
  {
    name: 'before-after-prepend-append',
    html: '<ul><li>b</li></ul>',
    ops: [
      { op: 'before', sel: 'li', html: '<li>a</li>' },
      { op: 'after', sel: 'li:last-child', html: '<li>c</li><li>d</li>' },
      { op: 'prepend', sel: 'ul', html: 'x' },
      { op: 'append', sel: 'ul', html: '<li>e</li>' },
      { op: 'html', sel: 'ul' }
    ]
  },
  {
    name: 'attributes-order-and-class',
    html: '<a href="x" CLASS="  a  b a " Title="T" data-x>l</a>',
    ops: [
      { op: 'get', sel: 'a', name: 'class' },
      { op: 'get', sel: 'a', name: 'CLASS' },
      { op: 'get', sel: 'a', name: 'title' },
      { op: 'get', sel: 'a', name: 'Title' },
      { op: 'setAttribute', sel: 'a', name: 'rel', value: 'nofollow' },
      { op: 'setAttribute', sel: 'a', name: 'class', value: 'z  y z' },
      { op: 'setAttribute', sel: 'a', name: 'id', value: 'q"r' },
      { op: 'removeAttribute', sel: 'a', name: 'href' },
      { op: 'get', sel: 'a', name: 'class' },
      { op: 'outer', sel: 'a' }
    ]
  },
  {
    name: 'class-list',
    html: '<p>a</p><p class="k">b</p>',
    ops: [
      { op: 'classAdd', sel: 'p', tokens: ['x', '', 'y', 'x'] },
      { op: 'classRemove', sel: 'p:last-child', tokens: ['k'] },
      { op: 'classToggle', sel: 'p:last-child', token: 'k', force: null },
      { op: 'classToggle', sel: 'p:last-child', token: 'k', force: null },
      { op: 'classToggle', sel: 'p:last-child', token: 'm', force: false },
      { op: 'classRemove', sel: 'p:last-child', tokens: ['nothing'] },
      { op: 'get', sel: 'p:last-child', name: 'class' }
    ]
  },
  {
    name: 'clone',
    html: '<html><body><div id="s"><p class="c" data-a="1">x<b>y</b></p><span></span></div></body></html>',
    ops: [
      { op: 'cloneAfter', sel: 'p', deep: true },
      { op: 'cloneAfter', sel: 'span', deep: false },
      { op: 'cloneAfter', sel: '#s', deep: true },
      { op: 'html', sel: 'body' }
    ]
  },
  {
    name: 'text-content-and-inner-html',
    html: '<div><b>x</b>y</div><script>var a = 1 < 2;</script><title>t &amp; u</title><style>p > a{}</style>',
    ops: [
      { op: 'text', sel: 'script' },
      { op: 'html', sel: 'script' },
      { op: 'textContent', sel: 'div', value: 'a < b & c' },
      { op: 'html', sel: 'div' },
      { op: 'innerHTML', sel: 'div', value: '<i>z</i> &lt; &copy;' },
      { op: 'html', sel: 'div' },
      { op: 'innerHTML', sel: 'script', value: '<b>not html</b>' },
      { op: 'outer', sel: 'script' },
      { op: 'outer', sel: 'title' },
      { op: 'textContent', sel: 'style', value: '' },
      { op: 'outer', sel: 'style' }
    ]
  },
  {
    name: 'move-nodes',
    html: '<html><body><div id="a"><p>1</p><p>2</p></div><div id="b"><em>e</em></div></body></html>',
    ops: [
      { op: 'moveInto', sel: '#a p', into: '#b' },
      { op: 'insertBefore', sel: '#a p', before: '#b em' },
      { op: 'html', sel: 'body' }
    ]
  },
  {
    name: 'normalize',
    html: '<p>a<b></b>b</p>',
    ops: [
      { op: 'append', sel: 'p', html: 'c' },
      { op: 'remove', sel: 'b' },
      { op: 'normalize', sel: 'p' },
      { op: 'html', sel: 'p' }
    ]
  },
  {
    name: 'replace-with-itself',
    html: '<div><p id="x">a</p><p>b</p></div>',
    ops: [
      { op: 'replaceWithSelf', sel: '#x' },
      { op: 'html', sel: 'div' }
    ]
  },
  {
    name: 'selectors-after-edits',
    html: '<html><body><div class="w"><p class="a">1</p><p>2</p><p class="a">3</p></div></body></html>',
    ops: [
      { op: 'remove', sel: 'p:first-child' },
      { op: 'query', sel: 'body', query: '.a' },
      { op: 'query', sel: 'body', query: 'p:first-child' },
      { op: 'query', sel: 'body', query: 'p:last-child' },
      { op: 'cloneAfter', sel: '.a', deep: true },
      { op: 'query', sel: 'body', query: 'p' },
      { op: 'query', sel: '.w', query: ':scope > p' }
    ]
  }
]

function nodesFrom(document, html) {
  const holder = document.createElement('div')
  holder.innerHTML = html
  return [...holder.childNodes]
}

/** Plays the operations on a linkedom document; mirrors `apply_ops` of the Rust test. */
export function playScenario({ html, ops }) {
  const { document } = parseHTML(html)
  const log = []
  const ordinalOf = (node) => {
    const all = []
    const visit = (parent) => {
      for (const child of parent.childNodes) {
        if (child.nodeType === 1) {
          all.push(child)
          visit(child)
        }
      }
    }
    visit(document)
    return all.indexOf(node)
  }
  for (const step of ops) {
    const target = document.querySelector(step.sel)
    if (!target) {
      log.push({ op: step.op, miss: step.sel })
      continue
    }
    switch (step.op) {
      case 'remove':
        target.remove()
        break
      case 'replaceWith':
        target.replaceWith(...nodesFrom(document, step.html))
        break
      case 'replaceWithSelf':
        target.replaceWith(target)
        break
      case 'before':
        target.before(...nodesFrom(document, step.html))
        break
      case 'after':
        target.after(...nodesFrom(document, step.html))
        break
      case 'prepend':
        target.prepend(...nodesFrom(document, step.html))
        break
      case 'append':
        target.append(...nodesFrom(document, step.html))
        break
      case 'setAttribute':
        target.setAttribute(step.name, step.value)
        break
      case 'removeAttribute':
        target.removeAttribute(step.name)
        break
      case 'textContent':
        target.textContent = step.value
        break
      case 'innerHTML':
        target.innerHTML = step.value
        break
      case 'cloneAfter':
        target.after(target.cloneNode(step.deep))
        break
      case 'classAdd':
        target.classList.add(...step.tokens)
        break
      case 'classRemove':
        target.classList.remove(...step.tokens)
        break
      case 'classToggle':
        log.push({
          op: step.op,
          value:
            step.force === null
              ? target.classList.toggle(step.token)
              : target.classList.toggle(step.token, step.force)
        })
        break
      case 'moveInto':
        document.querySelector(step.into).appendChild(target)
        break
      case 'insertBefore':
        {
          const reference = document.querySelector(step.before)
          reference.parentNode.insertBefore(target, reference)
        }
        break
      case 'normalize':
        target.normalize()
        break
      case 'get':
        log.push({ op: 'get', value: target.getAttribute(step.name) })
        break
      case 'text':
        log.push({ op: 'text', value: target.textContent.toWellFormed() })
        break
      case 'html':
        log.push({ op: 'html', value: target.innerHTML.toWellFormed() })
        break
      case 'outer':
        log.push({ op: 'outer', value: target.outerHTML.toWellFormed() })
        break
      case 'query':
        log.push({
          op: 'query',
          value: [...target.querySelectorAll(step.query)].map(ordinalOf)
        })
        break
      default:
        throw new Error(`unknown op ${step.op}`)
    }
  }
  return { log, document: document.toString().toWellFormed() }
}
