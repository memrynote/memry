/**
 * Stable per-renderer-instance id attached to note update calls. The main
 * process echoes it back in `notes:updated` events, letting this window
 * recognize echoes of its own saves and skip the editor remount they would
 * otherwise force (a remount mid-gesture destroys open BlockNote menus).
 * Updates from other writers (Agent Chat, other windows, external edits)
 * carry no/another originId and still trigger the remount path.
 */
export const NOTES_CLIENT_ORIGIN_ID = crypto.randomUUID()
