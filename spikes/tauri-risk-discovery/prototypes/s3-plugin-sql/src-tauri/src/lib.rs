mod bench_dump;

use tauri_plugin_sql::{Migration, MigrationKind};

// Schema applied as one Migration. Empty DB + Database.load triggers it.
// NOTE: statements separated by ";" are split by plugin-sql's migration
// runner. If multi-statement fails, pre-run a scratch sqlx query first.
const SCHEMA_V1: &str = "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER); CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC) WHERE deleted_at IS NULL; CREATE TABLE IF NOT EXISTS embeddings (note_id TEXT PRIMARY KEY, embedding BLOB NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, body); CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL);";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "create bench schema",
        sql: SCHEMA_V1,
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:s3-plugin-sql.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![bench_dump::bench_dump_results])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
