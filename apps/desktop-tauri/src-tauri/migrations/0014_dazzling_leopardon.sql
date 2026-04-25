-- Port of apps/desktop/src/main/database/drizzle-data/0014_dazzling_leopardon.sql
-- Identifiers unbacktick'd.

CREATE UNIQUE INDEX idx_unique_current_device ON sync_devices (is_current_device) WHERE is_current_device = 1;
