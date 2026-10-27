//! Spelling commands (`spell_check_word`, `spell_add_word`, `spell_add_words`). The backend may
//! wait on the main thread or on COM, so each call runs on the blocking pool.

use memry_desktop::shell::spell::{SpellResult, add_word, add_words, check_word};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::CommandError;
use crate::spell::SpellService;

/// Whether `word` is misspelled, with up to eight suggestions.
#[tauri::command]
#[specta::specta]
pub async fn spell_check_word(
    app: AppHandle<Wry>,
    word: String,
) -> Result<SpellResult, CommandError> {
    blocking("spell_check_word", move || {
        let backend = app.state::<SpellService>().backend();
        Ok(check_word(backend.as_deref(), &word))
    })
    .await
}

/// Adds `word` to the personal dictionary; false when it is not a valid word or the platform
/// refused.
#[tauri::command]
#[specta::specta]
pub async fn spell_add_word(app: AppHandle<Wry>, word: String) -> Result<bool, CommandError> {
    blocking("spell_add_word", move || {
        let backend = app.state::<SpellService>().backend();
        Ok(add_word(backend.as_deref(), &word))
    })
    .await
}

/// Adds each valid word and returns how many were taken (the Electron dictionary import).
#[tauri::command]
#[specta::specta]
pub async fn spell_add_words(app: AppHandle<Wry>, words: Vec<String>) -> Result<u32, CommandError> {
    blocking("spell_add_words", move || {
        let backend = app.state::<SpellService>().backend();
        Ok(add_words(backend.as_deref(), &words))
    })
    .await
}
