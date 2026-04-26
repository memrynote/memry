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
use tauri::Manager;

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
        .register_uri_scheme_protocol("memry-file", |ctx, request| {
            let app = ctx.app_handle().clone();
            handle_memry_file(&app, &request)
        })
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

fn handle_memry_file(
    app: &tauri::AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use std::fs;
    use tauri::http::{header, Response, StatusCode};

    let url = request.uri().to_string();
    // Format: memry-file://local/<absolute path>
    let path = match url.strip_prefix("memry-file://local/") {
        Some(p) => format!("/{}", urlencoding::decode(p).unwrap_or_default()),
        None => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(b"invalid memry-file url".to_vec())
                .unwrap();
        }
    };
    let abs = match dunce::canonicalize(&path) {
        Ok(a) => a,
        Err(_) => return missing(&path),
    };

    // Allowlist: app data dir + current vault root.
    let mut allowed: Vec<std::path::PathBuf> = Vec::new();
    if let Some(state) = app.try_state::<crate::app_state::AppState>() {
        if let Some(vault) = state.vault.current_path() {
            if let Ok(c) = dunce::canonicalize(&vault) {
                allowed.push(c);
            }
        }
    }
    if let Ok(dirs) = directories::ProjectDirs::from("com", "memry", "memry")
        .ok_or(())
        .map(|d| d.data_dir().to_path_buf())
    {
        if let Ok(c) = dunce::canonicalize(&dirs) {
            allowed.push(c);
        }
    }
    if !allowed.iter().any(|root| abs.starts_with(root)) {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(b"path not in allowed roots".to_vec())
            .unwrap();
    }

    let bytes = match fs::read(&abs) {
        Ok(b) => b,
        Err(_) => return missing(&path),
    };

    let mime = mime_guess::from_path(&abs)
        .first_or_octet_stream()
        .essence_str()
        .to_string();

    if let Some(range) = request.headers().get(header::RANGE) {
        if let Ok(range_str) = range.to_str() {
            if let Some(captures) = parse_range(range_str, bytes.len() as u64) {
                let (start, end) = captures;
                let slice = &bytes[start as usize..=end as usize];
                let len = slice.len();
                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, mime)
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{}", bytes.len()),
                    )
                    .header(header::CONTENT_LENGTH, len.to_string())
                    .header(header::ACCEPT_RANGES, "bytes")
                    .body(slice.to_vec())
                    .unwrap();
            }
        }
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .body(bytes)
        .unwrap()
}

fn missing(path: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let lower = path.to_lowercase();
    let is_image = lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp");
    if is_image {
        // 1x1 transparent PNG
        let bytes = base64_decode_static(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        );
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/png")
            .body(bytes)
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(b"not found".to_vec())
        .unwrap()
}

fn parse_range(header_value: &str, total: u64) -> Option<(u64, u64)> {
    let v = header_value.strip_prefix("bytes=")?;
    let (start_str, end_str) = v.split_once('-')?;
    let start: u64 = start_str.parse().ok().unwrap_or(0);
    let end: u64 = if end_str.is_empty() {
        total.saturating_sub(1)
    } else {
        end_str.parse().ok().unwrap_or(total.saturating_sub(1))
    };
    if start > end || end >= total {
        return None;
    }
    Some((start, end))
}

fn base64_decode_static(input: &str) -> Vec<u8> {
    use std::collections::HashMap;
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = HashMap::new();
    for (i, c) in alphabet.iter().enumerate() {
        lookup.insert(*c as char, i as u8);
    }
    let mut buf = 0u32;
    let mut bits = 0u32;
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    for c in input.chars() {
        if c == '=' {
            break;
        }
        if let Some(v) = lookup.get(&c) {
            buf = (buf << 6) | *v as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buf >> bits) as u8);
                buf &= (1u32 << bits) - 1;
            }
        }
    }
    out
}
