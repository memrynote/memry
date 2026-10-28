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
// a command can run twice (#3647, `shell::navigation_guard::linux`). Links and dropped links go
// through `lib/external-link-guard.ts`; app code never moves the window itself. `location.reload()`
// stays allowed: it reloads the app.
const LOCATION = "[object.name='location'], [object.property.name='location']"
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
    const report = (node) => context.report({ node, messageId: 'navigates' })
    return {
      [`CallExpression > MemberExpression.callee:matches(${LOCATION})[property.name=/^(assign|replace)$/]`]:
        report,
      [`AssignmentExpression > MemberExpression.left:matches(${LOCATION})[property.name='href']`]:
        report,
      "AssignmentExpression > MemberExpression.left[object.name=/^(window|document|globalThis|self|top)$/][property.name='location']":
        report
    }
  }
}

export default {
  meta: { name: 'memry' },
  rules: { 'no-window-fanout': noWindowFanout, 'no-location-navigation': noLocationNavigation }
}
