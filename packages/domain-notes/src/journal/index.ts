/**
 * The journal rules desktop and the iOS core must agree on (spec
 * 005-journal D4): preview, streak, month and year arithmetic, template
 * resolution and substitution. Pure functions only; every clock-dependent one
 * takes `today`, and locale formatting stays in the shells.
 *
 * `countWords` and `calculateActivityLevel` stay in `@memry/contracts/journal-api`.
 *
 * @module journal
 */
export * from './preview.ts'
export * from './stats.ts'
export * from './streak.ts'
export * from './templates.ts'
