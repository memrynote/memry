//! The installed font families, for the font picker. `queryLocalFonts` is Chromium-only, so the
//! list comes from the system through `font-kit`; it is read once and kept.

use std::sync::OnceLock;

use font_kit::source::SystemSource;

use crate::commands::error::{CommandError, ErrorKind};

static FAMILIES: OnceLock<Vec<String>> = OnceLock::new();

/// Family names, sorted, with no duplicates and no blank names.
fn load() -> Vec<String> {
    let mut families = SystemSource::new().all_families().unwrap_or_else(|error| {
        tracing::warn!(
            scope = "Fonts",
            "could not list the installed fonts: {error}"
        );
        Vec::new()
    });
    families.retain(|family| !family.trim().is_empty());
    families.sort_by_key(|family| family.to_lowercase());
    families.dedup();
    families
}

/// Every installed font family. Enumeration touches every font file, so it runs off the async
/// runtime.
#[tauri::command]
#[specta::specta]
pub async fn system_fonts_list() -> Result<Vec<String>, CommandError> {
    if let Some(families) = FAMILIES.get() {
        return Ok(families.clone());
    }
    let families = tauri::async_runtime::spawn_blocking(load)
        .await
        .map_err(|error| CommandError::new(ErrorKind::Internal, "fonts_list", error.to_string()))?;
    Ok(FAMILIES.get_or_init(|| families).clone())
}
