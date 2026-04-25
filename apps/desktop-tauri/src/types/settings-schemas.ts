/**
 * Settings type definitions used by the Tauri renderer.
 *
 * Phase F (M2) rehomes the narrow set of @memry/contracts/settings-schemas
 * types directly touched by the real settings_* IPC slice (`useSettings`
 * hook + acceptance grep paths). Other consumers in `src/lib/`, `src/hooks/`,
 * and `src/types/preload-types.ts` still import from `@memry/contracts/*`;
 * those references travel forward via the Phase G carry-forward ledger and
 * land alongside their respective domain slices in later milestones.
 *
 * Types kept structurally identical to the upstream Zod-inferred shapes in
 * packages/contracts/src/settings-schemas.ts so the local + package copies
 * remain interchangeable wherever both flow through the same component tree.
 */

export interface ShortcutBinding {
  key: string
  modifiers: {
    meta?: boolean
    ctrl?: boolean
    shift?: boolean
    alt?: boolean
  }
}

export interface CalendarSettings {
  dayCellClickBehavior: 'journal' | 'calendar'
  calendarPageClickOverride: 'inherit' | 'journal' | 'calendar'
}
