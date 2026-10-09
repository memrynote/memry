ALTER TABLE `note_tags` ADD `in_header` integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_note_tags_tag_header` ON `note_tags` (`tag`,`in_header`);
