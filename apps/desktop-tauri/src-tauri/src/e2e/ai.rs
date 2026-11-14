//! The inline AI row and key under test (Step 22, #3539), over `memry_desktop::e2e::ai_inline`.
//! `e2e/specs/editor/ai-keys.e2e.ts` drives them. Neither command returns a key.

use std::sync::Arc;

use memry_desktop::ai::settings::InlineAiStore;
use memry_desktop::e2e::ai_inline::{self, KeyState};
use memry_desktop::seams::secure_store::KeyringStore;
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::settings::SettingsService;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};

fn failed(code: &'static str, error: impl ToString) -> CommandError {
    CommandError::new(ErrorKind::Internal, code, error.to_string())
}

fn open(app: &AppHandle<Wry>) -> Result<OpenVault, CommandError> {
    app.state::<Session>()
        .current()
        .ok_or_else(|| failed("e2e_no_vault", "no vault is open"))
}

/// Writes `patch` into the open vault's `ai-inline` row as stored, as Electron left it.
#[tauri::command]
pub fn e2e_ai_inline_seed_row(
    app: AppHandle<Wry>,
    patch: Map<String, Value>,
) -> Result<(), CommandError> {
    ai_inline::seed_row(&app.state::<SettingsService>(), &open(&app)?, patch)
        .map_err(|error| failed("e2e_ai_inline_seed_row", error))
}

/// Whether the keychain holds `expected` for the row's selection, and the row holds no key.
#[tauri::command]
pub fn e2e_ai_inline_key_state(
    app: AppHandle<Wry>,
    expected: String,
) -> Result<KeyState, CommandError> {
    ai_inline::key_state(
        &app.state::<Arc<InlineAiStore>>(),
        &app.state::<SettingsService>(),
        app.state::<Arc<KeyringStore>>().as_ref(),
        &open(&app)?,
        &expected,
    )
    .map_err(|error| failed("e2e_ai_inline_key_state", error))
}
