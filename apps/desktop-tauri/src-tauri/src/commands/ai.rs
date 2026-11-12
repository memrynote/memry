//! Inline AI settings and keys (Step 22, #3539): the `ai-inline:*` channels of Electron's
//! `ipc/ai-inline-handlers.ts` without the localhost chat server. Each command is one call of
//! `memry_desktop::ai`; the key stays in Rust and the renderer gets it masked.

use std::sync::Arc;

use memry_desktop::ai::catalog::{self, ProbeFailure};
use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::settings::{
    AiSettingsError, InlineAiSettings, InlineAiStore, InlineAiUpdates,
};
use memry_desktop::i18n::{self, Arg, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::session::Session;
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use super::settings::map_error;
use crate::events::{AiInlineSettingsChangedEvent, broadcast};

/// The outcome of the settings screen's Test button. `detail` is the translated reason of a
/// failure, `None` when `ok`.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    pub detail: Option<String>,
}

fn store(app: &AppHandle<Wry>) -> Arc<InlineAiStore> {
    app.state::<Arc<InlineAiStore>>().inner().clone()
}

fn locale(app: &AppHandle<Wry>) -> &'static str {
    app.state::<Arc<LocaleService>>().get()
}

fn text(locale: &str, key: &str, provider: AiProvider) -> String {
    let args = Args::from([("provider".to_owned(), Arg::from(provider.label()))]);
    i18n::t(locale, key, &args)
}

/// A keychain failure reads the same whatever the cause; the code tells them apart.
fn settings_error(locale: &str, error: AiSettingsError) -> CommandError {
    match error {
        AiSettingsError::NoVault => {
            CommandError::new(ErrorKind::NotFound, "no_vault_open", error.to_string())
        }
        AiSettingsError::Settings(error) => map_error(error),
        AiSettingsError::Keychain(error) => {
            tracing::warn!(scope = "AIInline", "keychain: {error}");
            CommandError {
                message: i18n::t(locale, "errors:ai.keychainUnavailable", &Args::new()),
                ..CommandError::from_core(&error)
            }
        }
    }
}

fn read(app: &AppHandle<Wry>) -> Result<InlineAiSettings, CommandError> {
    let vault = app.state::<Session>().current();
    store(app)
        .read(vault.as_ref())
        .map_err(|error| settings_error(locale(app), error))
}

/// The settings with the key masked (`ai-inline:get-settings`).
#[tauri::command]
#[specta::specta]
pub async fn ai_inline_get_settings(app: AppHandle<Wry>) -> Result<InlineAiSettings, CommandError> {
    blocking("ai_inline_get_settings", move || {
        read(&app).map(InlineAiSettings::masked)
    })
    .await
}

/// Writes a partial update (`ai-inline:set-settings`) and returns the masked result. A masked
/// key is left alone, an empty key is deleted, any other key goes to the keychain.
#[tauri::command]
#[specta::specta]
pub async fn ai_inline_set_settings(
    app: AppHandle<Wry>,
    updates: InlineAiUpdates,
) -> Result<InlineAiSettings, CommandError> {
    blocking("ai_inline_set_settings", move || {
        let vault = app.state::<Session>().current();
        let settings = store(&app)
            .write(vault.as_ref(), updates)
            .map_err(|error| settings_error(locale(&app), error))?;
        broadcast(
            &app,
            AiInlineSettingsChangedEvent {
                settings: settings.clone(),
            },
        );
        Ok(settings)
    })
    .await
}

/// The models of the configured Ollama (`ai-inline:list-ollama-models`). Nothing listening is
/// the normal "Ollama is not running": `Transport` with code `ai.ollamaUnreachable`, logged at
/// info.
#[tauri::command]
#[specta::specta]
pub async fn ai_inline_list_ollama_models(
    app: AppHandle<Wry>,
) -> Result<Vec<String>, CommandError> {
    let settings = {
        let app = app.clone();
        blocking("ai_inline_list_ollama_models", move || read(&app)).await?
    };
    catalog::list_ollama_models(&memry_desktop::http::client(), &settings.base_url)
        .await
        .map_err(|failure| {
            let locale = locale(&app);
            let error = match failure {
                ProbeFailure::Unreachable => {
                    tracing::info!(scope = "AIInline", "Ollama is not running");
                    return CommandError::new(
                        ErrorKind::Transport,
                        "ai.ollamaUnreachable",
                        i18n::t(locale, "errors:ai.ollamaUnreachable", &Args::new()),
                    );
                }
                other => CommandError::new(
                    ErrorKind::Transport,
                    "ai.listOllamaModelsFailed",
                    format!(
                        "{}: {other}",
                        i18n::t(locale, "errors:ai.listOllamaModelsFailed", &Args::new())
                    ),
                ),
            };
            log_failure("ai_inline_list_ollama_models", &error);
            error
        })
}

/// Whether the configured provider answers with the stored key: Ollama lists its models, the
/// others answer `GET /models`. A refusal is an answer, not a failed call.
#[tauri::command]
#[specta::specta]
pub async fn ai_inline_test_connection(
    app: AppHandle<Wry>,
) -> Result<TestConnectionResult, CommandError> {
    let settings = {
        let app = app.clone();
        blocking("ai_inline_test_connection", move || read(&app)).await?
    };
    let locale = locale(&app);
    let provider = settings.provider;
    if !settings.enabled {
        return Ok(TestConnectionResult {
            ok: false,
            detail: Some(i18n::t(locale, "errors:ai.inlineDisabled", &Args::new())),
        });
    }
    let outcome = catalog::test_connection(&memry_desktop::http::client(), &settings).await;
    let detail = match outcome {
        Ok(()) => None,
        Err(ProbeFailure::KeyMissing) => Some(text(locale, "errors:ai.apiKeyMissing", provider)),
        Err(ProbeFailure::Unauthorized) => Some(text(locale, "errors:ai.apiKeyInvalid", provider)),
        Err(ProbeFailure::Unreachable) if provider == AiProvider::Ollama => {
            Some(i18n::t(locale, "errors:ai.ollamaUnreachable", &Args::new()))
        }
        Err(ProbeFailure::Unreachable) => {
            Some(text(locale, "errors:ai.providerUnreachable", provider))
        }
        Err(ProbeFailure::Other(reason)) => {
            tracing::warn!(scope = "AIInline", "connection test failed: {reason}");
            Some(reason)
        }
    };
    Ok(TestConnectionResult {
        ok: detail.is_none(),
        detail,
    })
}
