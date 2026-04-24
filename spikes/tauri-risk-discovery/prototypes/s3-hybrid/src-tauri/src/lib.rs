mod bench_dump;
mod db_c;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // plugin-sql opens the same SQLite file Rust set up via rusqlite.
        // No migrations registered here — rusqlite owns schema (idempotent
        // CREATE IF NOT EXISTS in db_c::init_schema).
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            let path = db_c::db_path(app.handle());
            let db = db_c::OptionCDb::open(&path).expect("open Option C DB");
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_c::db_version,
            db_c::option_c_bulk_insert,
            db_c::option_c_seed_notes,
            db_c::option_c_seed_embeddings,
            db_c::option_c_vector_search,
            db_c::option_c_fts_search,
            db_c::option_c_blob_write,
            db_c::option_c_blob_read,
            bench_dump::bench_dump_results,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
