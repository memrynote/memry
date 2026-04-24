mod bench_dump;
mod db_a;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = db_a::db_path(app.handle());
            let db = db_a::OptionADb::open(&path).expect("open Option A DB");
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_a::db_version,
            db_a::option_a_list_notes,
            db_a::option_a_get_note,
            db_a::option_a_bulk_insert,
            db_a::option_a_seed_notes,
            db_a::option_a_seed_embeddings,
            db_a::option_a_vector_search,
            db_a::option_a_fts_search,
            db_a::option_a_blob_write,
            db_a::option_a_blob_read,
            db_a::option_a_count_notes,
            bench_dump::bench_dump_results,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
