ALTER TABLE `note_tags` ADD `pinned_at` text;--> statement-breakpoint
CREATE INDEX `idx_note_tags_pinned` ON `note_tags` (`pinned_at`);