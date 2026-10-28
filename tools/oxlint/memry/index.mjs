// Guard against a fourth regression of #935/#1000: hand-rolled fan-out loops
// that call webContents.send() on every window. getAllWindows() can list a
// destroyed short-lived window (splash, quick capture, print/export), and the
// send then throws "Object has been destroyed" — inside a sync item handler
// that throw escapes ctx.emit within the item's DB transaction and rolls back
// an already-applied item. broadcastToAllWindows() skips destroyed windows and
// contains a per-window failure so the rest of the fan-out still lands.
//
// Scope note: the selectors are anchored on getAllWindows() itself, so they
// stay free of false positives — a loop over a deliberate *subset* of windows
// (e.g. crdt-provider's per-doc windowIds, which must skip the source window)
// is a different thing and must not be rewritten to a fan-out. The two-step
// form (`const windows = getAllWindows()` then iterating `windows`) is not
// statically distinguishable from legitimate window selection and is not
// caught. This is a regression tripwire for the shape that has actually
// recurred, not a proof of absence.
const SENDS = ":has(MemberExpression[object.property.name='webContents'][property.name='send'])"

const noWindowFanout = {
  meta: {
    type: 'problem',
    messages: {
      handRolled:
        'Do not hand-roll a window fan-out loop. Use broadcastToAllWindows() from main/lib/window-broadcast — it skips destroyed windows, whose webContents.send() throws and can roll back a sync transaction (#935, #1000).'
    },
    schema: []
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'handRolled' })
    return {
      [`ForOfStatement[right.callee.property.name='getAllWindows']${SENDS}`]: report,
      [`CallExpression[callee.object.callee.property.name='getAllWindows'][callee.property.name='forEach']${SENDS}`]:
        report
    }
  }
}

// The Tauri shell refuses a main-frame navigation off the app only after WebKitGTK ran the page's
// beforeunload and cancelled its in-flight requests, and Tauri resends an aborted ipc:// command, so
// a command can run twice (#3647, `shell::navigation_guard::linux`). Links and drops go through
// `lib/external-link-guard.ts`; app code never moves the window itself. Allowed: `location.reload()`
// (it reloads the app) and `location.hash` (a fragment stays in the document).
const WINDOW_NAMES = new Set(['window', 'document', 'globalThis', 'self', 'top', 'parent'])
// Setting any of these loads another document.
const NAVIGATING_PARTS = new Set([
  'href',
  'protocol',
  'host',
  'hostname',
  'port',
  'pathname',
  'search'
])
const NAVIGATING_CALLS = new Set(['assign', 'replace'])
const TOP_FRAME_TARGETS = new Set(['_self', '_top', '_parent'])
const LOCATION_NAMES = new Set(['location'])
const OBJECT_NAMES = new Set(['Object'])
const OPEN_NAMES = new Set(['open'])

/** A string literal, or a template literal without expressions. */
function staticString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0].value.cooked
  return null
}

/** `a.b` or `a['b']`. */
function propertyName(member) {
  if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : null
  const key = member.property
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : null
}

const TS_WRAPPERS = new Set([
  'TSAsExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSSatisfiesExpression',
  'ParenthesizedExpression'
])

/** `window`, seen through `(window as Window)`, `window!` and parentheses. */
function unwrap(node) {
  while (TS_WRAPPERS.has(node.type)) node = node.expression
  return node
}

/** Whether a name is the window's own: no enclosing scope declares it. */
function globals(sourceCode) {
  const isUndeclared = (node) => {
    for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
      if (scope.set.get(node.name)?.defs.length) return false
    }
    return true
  }
  const isGlobal = (node, names) => {
    const bare = unwrap(node)
    return bare.type === 'Identifier' && names.has(bare.name) && isUndeclared(bare)
  }
  return { isGlobal, isWindow: (node) => isGlobal(node, WINDOW_NAMES) }
}

const noLocationNavigation = {
  meta: {
    type: 'problem',
    messages: {
      navigates:
        'Do not navigate the window from app code. Open a web link with commands.shellOpenExternal (or an <a href>, which external-link-guard.ts routes); on Linux a main-frame navigation cancels in-flight requests and can run an IPC command twice (#3647).'
    },
    schema: []
  },
  create(context) {
    const { sourceCode } = context
    const report = (node) => context.report({ node, messageId: 'navigates' })
    /** Identifiers that read a local bound to the window's Location (`const l = window.location`). */
    const aliasReads = new Set()
    const { isGlobal, isWindow } = globals(sourceCode)
    const isWindowLocation = (node) =>
      node.type === 'MemberExpression' && propertyName(node) === 'location' && isWindow(node.object)
    const isLocation = (node) =>
      isGlobal(node, LOCATION_NAMES) || isWindowLocation(node) || aliasReads.has(node)
    return {
      VariableDeclarator(node) {
        if (!node.init || !isLocation(node.init)) return
        for (const variable of sourceCode.getDeclaredVariables(node)) {
          for (const reference of variable.references) {
            if (reference.isRead()) aliasReads.add(reference.identifier)
          }
        }
      },
      AssignmentExpression(node) {
        const { left } = node
        if (isGlobal(left, LOCATION_NAMES) || isWindowLocation(left)) return report(node)
        if (
          left.type === 'MemberExpression' &&
          NAVIGATING_PARTS.has(propertyName(left)) &&
          isLocation(left.object)
        ) {
          report(node)
        }
      },
      CallExpression(node) {
        const { callee } = node
        if (
          callee.type === 'MemberExpression' &&
          NAVIGATING_CALLS.has(propertyName(callee)) &&
          isLocation(callee.object)
        ) {
          return report(node)
        }
        // `Object.assign(location, { href })` sets the parts one by one.
        if (
          callee.type === 'MemberExpression' &&
          propertyName(callee) === 'assign' &&
          isGlobal(callee.object, OBJECT_NAMES) &&
          node.arguments[0] &&
          isLocation(node.arguments[0])
        ) {
          return report(node)
        }
        const isOpen =
          isGlobal(callee, new Set(['open'])) ||
          (callee.type === 'MemberExpression' &&
            propertyName(callee) === 'open' &&
            isWindow(callee.object))
        if (isOpen && TOP_FRAME_TARGETS.has(staticString(node.arguments[1]))) {
          report(node)
        }
      }
    }
  }
}

// `window.open` from the Tauri renderer: on macOS WKWebView opens nothing and the shell never
// hears of it (#3675). `openLink` (`lib/external-link-guard.ts`) hands the URL to the shell, which
// opens a web or mail link in the browser and a vault file in its app, as Electron's
// `setWindowOpenHandler` did. Any read of the window's `open` is reported, a callback included.
const noWindowOpen = {
  meta: {
    type: 'problem',
    messages: {
      opens:
        "Do not call window.open: on macOS it opens nothing (#3675). Use openLink from '@/lib/external-link-guard', which opens a web or mail link in the OS browser and a vault file in its app."
    },
    schema: []
  },
  create(context) {
    const { isGlobal, isWindow } = globals(context.sourceCode)
    const report = (node) => context.report({ node, messageId: 'opens' })
    /** `const { open } = window`, `({ open: go } = globalThis)`. */
    const destructuresOpen = (pattern, source) =>
      pattern.type === 'ObjectPattern' &&
      source &&
      isWindow(source) &&
      pattern.properties.some(
        (p) =>
          p.type === 'Property' &&
          !p.computed &&
          ((p.key.type === 'Identifier' && p.key.name === 'open') || p.key.value === 'open')
      )
    return {
      MemberExpression(node) {
        if (propertyName(node) === 'open' && isWindow(node.object)) report(node)
      },
      // A read of the global `open` itself: a call, a callback, `open.call(...)`.
      Identifier(node) {
        const { parent } = node
        const isName =
          (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
          ((parent.type === 'Property' ||
            parent.type === 'MethodDefinition' ||
            parent.type === 'PropertyDefinition') &&
            parent.key === node &&
            !parent.computed) ||
          parent.type.startsWith('TS') ||
          // A destructuring target: the pattern visitors below decide it.
          (parent.type === 'Property' && parent.parent.type === 'ObjectPattern')
        if (!isName && isGlobal(node, OPEN_NAMES)) report(node)
      },
      VariableDeclarator(node) {
        if (destructuresOpen(node.id, node.init)) report(node)
      },
      AssignmentExpression(node) {
        if (destructuresOpen(node.left, node.right)) report(node)
      }
    }
  }
}

export default {
  meta: { name: 'memry' },
  rules: {
    'no-window-fanout': noWindowFanout,
    'no-location-navigation': noLocationNavigation,
    'no-window-open': noWindowOpen
  }
}
