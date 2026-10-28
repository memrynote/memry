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

/** `a.b` or `a['b']`. */
function propertyName(member) {
  if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : null
  const key = member.property
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : null
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
    /** The name is the window's own: no enclosing scope declares it. */
    const isUndeclared = (node) => {
      for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
        if (scope.set.get(node.name)?.defs.length) return false
      }
      return true
    }
    const isGlobal = (node, names) =>
      node.type === 'Identifier' && names.has(node.name) && isUndeclared(node)
    const isWindow = (node) => isGlobal(node, WINDOW_NAMES)
    const isWindowLocation = (node) =>
      node.type === 'MemberExpression' && propertyName(node) === 'location' && isWindow(node.object)
    const isLocation = (node) =>
      isGlobal(node, new Set(['location'])) || isWindowLocation(node) || aliasReads.has(node)
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
        if (isGlobal(left, new Set(['location'])) || isWindowLocation(left)) return report(node)
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
        const isOpen =
          isGlobal(callee, new Set(['open'])) ||
          (callee.type === 'MemberExpression' &&
            propertyName(callee) === 'open' &&
            isWindow(callee.object))
        const target = node.arguments[1]
        if (isOpen && target?.type === 'Literal' && TOP_FRAME_TARGETS.has(target.value)) {
          report(node)
        }
      }
    }
  }
}

export default {
  meta: { name: 'memry' },
  rules: { 'no-window-fanout': noWindowFanout, 'no-location-navigation': noLocationNavigation }
}
