/**
 * Data-DB row keys used by settings sync.
 *
 * Split out of `settings-sync.ts` so a reader that only needs the key — the
 * one-time `openPagesInNewTab` flip asks whether a field clock exists — can
 * have it without importing the manager and its sync-queue dependencies.
 *
 * @module main/sync/settings-sync-keys
 */

/** The merged settings blob this device has agreed with its peers. */
export const SETTINGS_SYNC_SETTINGS_KEY = 'synced_settings'

/** Per-field vector clocks, keyed by dotted field path (`general.theme`). */
export const SETTINGS_SYNC_CLOCKS_KEY = 'synced_settings_clocks'
