pub mod app_state;
pub mod commands;
pub mod db;
pub mod error;
pub mod vault;

use app_state::AppState;
use db::Db;
use directories::ProjectDirs;
use error::{AppError, AppResult};
use std::path::PathBuf;

fn resolve_db_path() -> AppResult<PathBuf> {
    let device = std::env::var("MEMRY_DEVICE").unwrap_or_else(|_| "default".to_string());
    let project_dirs = ProjectDirs::from("com", "memry", "memry")
        .ok_or_else(|| AppError::Internal("could not determine OS project dirs".to_string()))?;

    Ok(project_dirs
        .data_dir()
        .join(format!("memry-{device}"))
        .join("data.db"))
}

fn init_app_state() -> AppResult<AppState> {
    let db_path = resolve_db_path()?;
    let db = Db::open(db_path)?;
    let vault = std::sync::Arc::new(crate::vault::VaultRuntime::boot()?);
    Ok(AppState::new(db, vault))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = init_app_state().expect("failed to initialize app state");
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::settings::settings_list,
            commands::vault::vault_open,
            commands::vault::vault_close,
            commands::vault::vault_get_status,
            commands::vault::vault_get_current,
            commands::vault::vault_get_all,
            commands::vault::vault_switch,
            commands::vault::vault_remove,
            commands::vault::vault_get_config,
            commands::vault::vault_update_config,
            commands::vault::vault_list_notes,
            commands::vault::vault_read_note,
            commands::vault::vault_write_note,
            commands::vault::vault_delete_note,
            commands::vault::vault_reveal,
            commands::vault::vault_reindex,
            commands::shell::shell_open_url,
            commands::shell::shell_open_path,
            commands::shell::shell_reveal_in_finder,
            commands::dialog::dialog_choose_folder,
            commands::dialog::dialog_choose_files,
        ])
        .setup(|_app| {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("memry=info")),
                )
                .json()
                .init();
            tracing::info!("memry desktop-tauri booting (m2 settings slice)");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
