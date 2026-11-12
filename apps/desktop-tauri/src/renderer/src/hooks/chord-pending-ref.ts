/**
 * Whether the first key of a pane chord (⌘K) is down and its second key is awaited. A surface that
 * takes keys the chord also uses (Shift+Arrow) leaves them alone only while this is set.
 */
export const chordPendingRef: { current: boolean } = { current: false }
