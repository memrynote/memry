-- M5: SQL-backed folder template payloads for notes commands.

ALTER TABLE folder_configs ADD COLUMN template_json text;
