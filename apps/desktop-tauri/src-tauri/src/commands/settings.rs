use crate::app_state::AppState;
use crate::db::settings::{self, Setting};
use crate::error::AppResult;
use serde::Deserialize;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsGetInput {
    pub key: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetInput {
    pub key: String,
    pub value: String,
}

#[tauri::command]
#[specta::specta]
pub async fn settings_get(
    state: tauri::State<'_, AppState>,
    input: SettingsGetInput,
) -> AppResult<Option<String>> {
    settings::get(&state.db, &input.key)
}

#[tauri::command]
#[specta::specta]
pub async fn settings_set(
    state: tauri::State<'_, AppState>,
    input: SettingsSetInput,
) -> AppResult<()> {
    settings::set(&state.db, &input.key, &input.value)
}

#[tauri::command]
#[specta::specta]
pub async fn settings_list(state: tauri::State<'_, AppState>) -> AppResult<Vec<Setting>> {
    settings::list(&state.db)
}
