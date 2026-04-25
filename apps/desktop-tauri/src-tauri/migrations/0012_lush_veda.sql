-- Port of apps/desktop/src/main/database/drizzle-data/0012_lush_veda.sql
-- Identifiers unbacktick'd.

ALTER TABLE sync_devices ADD signing_public_key text;
