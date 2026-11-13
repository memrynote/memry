//! Inline AI settings, keys and the provider proxy (Step 22, #3539): the `ai-inline:*` channels
//! of Electron's `ipc/ai-inline-handlers.ts`, and in place of its localhost chat server the
//! authenticated `fetch` of the renderer's AI SDK. Each command is one call of
//! `memry_desktop::ai`; the key stays in Rust and the renderer gets it masked.

use std::sync::Arc;

use memry_desktop::ai::catalog::{self, ProbeClient, ProbeFailure};
use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::proxy::{AiProviderHead, AiProviderRequest, AiProxy, ProxyError};
use memry_desktop::ai::settings::{
    AiSettingsError, InlineAiSettings, InlineAiStore, InlineAiUpdates,
};
use memry_desktop::i18n::{self, Arg, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::session::Session;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Runtime, Webview, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use super::settings::map_error;
use crate::binary;
use crate::events::{AiInlineSettingsChangedEvent, broadcast};

/// The outcome of the settings screen's Test button. `detail` is the translated reason of a
/// failure, `None` when `ok`.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    pub detail: Option<String>,
}

fn store<R: Runtime>(app: &AppHandle<R>) -> Arc<InlineAiStore> {
    app.state::<Arc<InlineAiStore>>().inner().clone()
}

fn locale<R: Runtime>(app: &AppHandle<R>) -> &'static str {
    app.state::<Arc<LocaleService>>().get()
}

pub(super) fn text(locale: &str, key: &str, settings: &InlineAiSettings) -> String {
    let name = settings.provider.name(&settings.base_url);
    let args = Args::from([("provider".to_owned(), Arg::from(name.as_str()))]);
    i18n::t(locale, key, &args)
}

/// A keychain failure reads the same whatever the cause; the code tells them apart.
pub(super) fn settings_error(locale: &str, error: AiSettingsError) -> CommandError {
    match error {
        AiSettingsError::NoVault => {
            CommandError::new(ErrorKind::NotFound, "no_vault_open", error.to_string())
        }
        AiSettingsError::Settings(error) => map_error(error),
        // The settings screen holds the key field until the URL parses, so only a stale or
        // scripted call lands here.
        AiSettingsError::NoKeyTarget => {
            CommandError::new(ErrorKind::Invalid, "ai.noKeyTarget", error.to_string())
        }
        AiSettingsError::Keychain(error) => {
            tracing::warn!(scope = "AIInline", "keychain: {error}");
            CommandError {
                message: i18n::t(locale, "errors:ai.keychainUnavailable", &Args::new()),
                ..CommandError::from_core(&error)
            }
        }
    }
}

fn read<R: Runtime>(app: &AppHandle<R>) -> Result<InlineAiSettings, CommandError> {
    let vault = app.state::<Session>().current();
    store(app)
        .read(vault.as_ref())
        .map_err(|error| settings_error(locale(app), error))
}

/// The settings with the key masked (`ai-inline:get-settings`). The key itself is never read,
/// so a locked keychain still opens the screen.
#[tauri::command]
#[specta::specta]
pub async fn ai_inline_get_settings<R: Runtime>(
    app: AppHandle<R>,
) -> Result<InlineAiSettings, CommandError> {
    blocking("ai_inline_get_settings", move || {
        let vault = app.state::<Session>().current();
        store(&app)
            .masked(vault.as_ref())
            .map_err(|error| settings_error(locale(&app), error))
    })
    .await
}

/// Writes a partial update (`ai-inline:set-settings`) and returns the masked result. A masked
/// key is left alone, an empty key is deleted, any other key goes to the keychain.
#[tauri::command]
#[specta::specta]
pub async fn ai_inline_set_settings<R: Runtime>(
    app: AppHandle<R>,
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

/// The models of the configured provider (`ai-inline:list-models`), asked with its key. Nothing
/// listening at Ollama's address is the normal "Ollama is not running": `Transport` with code
/// `ai.ollamaUnreachable`, logged at info. Every other failure is `ai.listModelsFailed`.
#[tauri::command]
#[specta::specta]
pub async fn ai_inline_list_models(app: AppHandle<Wry>) -> Result<Vec<String>, CommandError> {
    let settings = {
        let app = app.clone();
        blocking("ai_inline_list_models", move || read(&app)).await?
    };
    catalog::list_models(&ProbeClient::new(memry_desktop::http::builder()), &settings)
        .await
        .map_err(|failure| {
            let locale = locale(&app);
            let error = match failure {
                ProbeFailure::Unreachable if settings.provider == AiProvider::Ollama => {
                    tracing::info!(scope = "AIInline", "Ollama is not running");
                    return CommandError::new(
                        ErrorKind::Transport,
                        "ai.ollamaUnreachable",
                        i18n::t(locale, "errors:ai.ollamaUnreachable", &Args::new()),
                    );
                }
                other => CommandError::new(
                    ErrorKind::Transport,
                    "ai.listModelsFailed",
                    format!(
                        "{}: {other}",
                        i18n::t(locale, "errors:ai.listModelsFailed", &Args::new())
                    ),
                ),
            };
            log_failure("ai_inline_list_models", &error);
            error
        })
}

/// Whether the configured provider answers `GET /models` with the stored key. A refusal is an
/// answer, not a failed call.
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
    if !settings.enabled {
        return Ok(TestConnectionResult {
            ok: false,
            detail: Some(i18n::t(locale, "errors:ai.inlineDisabled", &Args::new())),
        });
    }
    let outcome =
        catalog::test_connection(&ProbeClient::new(memry_desktop::http::builder()), &settings)
            .await;
    let detail = match outcome {
        Ok(()) => None,
        Err(ProbeFailure::KeyMissing) => Some(text(locale, "errors:ai.apiKeyMissing", &settings)),
        Err(ProbeFailure::Unauthorized) => Some(text(locale, "errors:ai.apiKeyInvalid", &settings)),
        Err(ProbeFailure::Unreachable) if settings.provider == AiProvider::Ollama => {
            Some(i18n::t(locale, "errors:ai.ollamaUnreachable", &Args::new()))
        }
        Err(ProbeFailure::Unreachable) => {
            Some(text(locale, "errors:ai.providerUnreachable", &settings))
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

/// One provider call of the renderer's AI SDK (its `fetch`), sent with the stored key. Answers
/// with the provider's status and headers; the body follows on `on_chunk` as tagged frames
/// (`memry_desktop::ai::proxy::Frame`). A binary command: the frames are raw bytes. The call
/// belongs to the calling webview and ends when its page goes ([`release_page`]).
#[tauri::command]
pub async fn ai_provider_request<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: AiProviderRequest,
    on_chunk: Channel<InvokeResponseBody>,
) -> Result<AiProviderHead, CommandError> {
    let proxy = app.state::<Arc<AiProxy>>().inner().clone();
    // Taken before the read: a reload while it waits refuses the request at `open`.
    let owner = proxy.owner(webview.label());
    let read = {
        let app = app.clone();
        blocking("ai_provider_request", move || read(&app)).await
    };
    let settings = match read {
        Ok(settings) => settings,
        Err(error) => {
            proxy.forget_cancel(&request.request_id);
            return Err(error);
        }
    };
    let sink = Box::new(move |frame: memry_desktop::ai::proxy::Frame| {
        binary::send_chunk(&on_chunk, frame.encode()).is_ok()
    });
    match proxy.open(&settings, request, &owner, sink).await {
        Ok((head, body)) => {
            tauri::async_runtime::spawn(body);
            Ok(head)
        }
        Err(error) => {
            let error = proxy_error(locale(&app), &settings, error);
            log_failure("ai_provider_request", &error);
            Err(error)
        }
    }
}

/// Ends a provider call the renderer aborted, before or after its head.
#[tauri::command]
#[specta::specta]
pub fn ai_provider_cancel<R: Runtime>(app: AppHandle<R>, request_id: String) {
    app.state::<Arc<AiProxy>>().cancel(&request_id);
}

/// Ends the provider calls of the webview labelled `label`: its page reloaded or its window
/// closed. `Channel::send` keeps succeeding after that, so a body would stream into a dead
/// callback until the provider finished.
pub fn release_page<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(proxy) = app.try_state::<Arc<AiProxy>>() {
        proxy.cancel_owner(label);
    }
}

fn proxy_error(locale: &str, settings: &InlineAiSettings, error: ProxyError) -> CommandError {
    let (kind, code, message) = match &error {
        ProxyError::KeyMissing { .. } => (
            ErrorKind::Invalid,
            "ai.apiKeyMissing",
            text(locale, "errors:ai.apiKeyMissing", settings),
        ),
        ProxyError::Disabled => (
            ErrorKind::Invalid,
            "ai.inlineDisabled",
            i18n::t(locale, "errors:ai.inlineDisabled", &Args::new()),
        ),
        ProxyError::Unreachable { .. } if settings.provider == AiProvider::Ollama => (
            ErrorKind::Transport,
            "ai.ollamaUnreachable",
            i18n::t(locale, "errors:ai.ollamaUnreachable", &Args::new()),
        ),
        ProxyError::Unreachable { .. } => (
            ErrorKind::Transport,
            "ai.providerUnreachable",
            text(locale, "errors:ai.providerUnreachable", settings),
        ),
        // The inline chat server's 413 text (`ai-chat-server.ts`).
        ProxyError::TooLarge => (
            ErrorKind::Invalid,
            "ai.requestTooLarge",
            "Request body too large".to_owned(),
        ),
        ProxyError::Cancelled => (ErrorKind::Invalid, "ai.cancelled", error.to_string()),
        ProxyError::VaultClosed => (ErrorKind::Invalid, "ai.vaultClosed", error.to_string()),
        ProxyError::AnswerTooLarge { .. } | ProxyError::BrokeOff(_) => {
            (ErrorKind::Transport, "ai.brokeOff", error.to_string())
        }
        ProxyError::ProviderChanged => {
            (ErrorKind::Invalid, "ai.providerChanged", error.to_string())
        }
        ProxyError::Invalid(_) => (ErrorKind::Invalid, "ai.invalidRequest", error.to_string()),
    };
    CommandError::new(kind, code, message)
}
