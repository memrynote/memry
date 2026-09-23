-- Length of a task's calendar time block (#2242).
--
-- Additive only. One nullable column, no backfill. Existing rows read NULL,
-- which renders exactly as before: a timed task keeps the default block length.
--
-- A downgrade is inert: an older build never selects the column by name, so its
-- rows keep whatever value a newer build wrote.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
ALTER TABLE `tasks` ADD COLUMN `duration_minutes` integer;
