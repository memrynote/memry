-- Nullable and unread by older builds (Drizzle lists columns explicitly), so a
-- downgrade leaves the column inert.
ALTER TABLE `tasks` ADD COLUMN `duration_minutes` integer;
