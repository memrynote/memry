-- Device-local part of each settings group (Step 09). One JSON object per group,
-- keyed by the group name (`general`, `editor`, ...). Additive: one new table, no
-- existing table or row touched, and an older build never reads it.
--
-- Fields that sync (`domain::app_settings::syncable`) never live here: the synced
-- settings item owns them, so a field has one owner and one clock. This table
-- holds only what stays on this device and vault: `startOnBoot`, `zoomFactor`,
-- the Tasks and Backup groups, the keyboard overrides, and any field this build
-- does not know (kept verbatim).
CREATE TABLE IF NOT EXISTS local_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
