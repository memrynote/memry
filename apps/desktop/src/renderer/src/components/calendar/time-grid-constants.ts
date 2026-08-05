/**
 * Geometry shared by every time-grid surface (day view, week view, marquee
 * quick-create, event drag/resize) and by the e2e specs that drive them with
 * raw mouse coordinates.
 *
 * These were duplicated per module once, which let a row-height change land in
 * some copies and not others — and left the e2e drags silently covering twice
 * the intended duration. One definition, imported everywhere.
 */

/** Pixel height of one hour row. */
export const HOUR_HEIGHT = 48

/** Marquee/drag snapping granularity, in minutes. */
export const SNAP_MINUTES = 15
