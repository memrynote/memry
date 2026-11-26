-- Canvas documents move out of the encrypted `snapshot_ciphertext` column and
-- into plain `.excalidraw` files inside the vault (`canvases/<Title>.excalidraw`).
--
-- Additive only: `snapshot_ciphertext` stays NOT NULL and keeps its data. The
-- one-way migration (canvas/reconcile.ts) writes the file, records `file_path`
-- and blanks the ciphertext to ''. A row we cannot decrypt keeps its ciphertext
-- and a NULL file_path so the ink is never thrown away.
ALTER TABLE `canvases` ADD `file_path` text;
--> statement-breakpoint
CREATE INDEX `canvases_by_file_path` ON `canvases` (`vault_id`,`file_path`);
