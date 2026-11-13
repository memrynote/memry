//! Local agent provider settings (Step 22, #3539): the `agent:*LocalProvider*` and
//! `agent:listLocalModels` channels of Electron's `ipc/agent-handlers.ts`. Each command is one
//! call of `memry_desktop::ai::local_provider`; the key stays in Rust and the renderer learns
//! only whether one is stored.

use std::sync::Arc;

use memry_desktop::ai::catalog::ProbeClient;
use memry_desktop::ai::local_provider::probe::{
    self, AgentLocalModelList, AgentLocalProviderProbeResult,
};
use memry_desktop::ai::local_provider::{
    AgentLocalProviderSettings, AgentLocalProviderSettingsUpdate, LocalProvider,
    LocalProviderError, LocalProviderStore,
};
use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};

const SCOPE: &str = "AgentLocalProvider";

fn store<R: Runtime>(app: &AppHandle<R>) -> Arc<LocalProviderStore> {
    app.state::<Arc<LocalProviderStore>>().inner().clone()
}

fn store_error<R: Runtime>(app: &AppHandle<R>, error: LocalProviderError) -> CommandError {
    match error {
        LocalProviderError::InvalidUrl(_) => CommandError::new(
            ErrorKind::Invalid,
            "agent.invalidBaseUrl",
            error.to_string(),
        ),
        LocalProviderError::NonLoopback => CommandError::new(
            ErrorKind::Invalid,
            "agent.nonLoopbackUnconfirmed",
            error.to_string(),
        ),
        LocalProviderError::Config(error) => {
            CommandError::new(ErrorKind::Storage, "agent_prefs_write", error.to_string())
        }
        LocalProviderError::Keychain(error) => {
            tracing::warn!(scope = SCOPE, "keychain: {error}");
            let locale = app.state::<Arc<LocaleService>>().get();
            CommandError {
                message: i18n::t(locale, "errors:ai.keychainUnavailable", &Args::new()),
                ..CommandError::from_core(&error)
            }
        }
    }
}

/// The settings with the key, read off the async runtime (the keychain call can block).
async fn read<R: Runtime>(
    app: &AppHandle<R>,
    command: &'static str,
) -> Result<LocalProvider, CommandError> {
    let app = app.clone();
    blocking(command, move || {
        store(&app).read().map_err(|error| {
            let error = store_error(&app, error);
            log_failure(command, &error);
            error
        })
    })
    .await
}

fn client() -> ProbeClient {
    ProbeClient::new(memry_desktop::http::builder())
}

/// `agent:getLocalProviderSettings`. A locked keychain still opens the screen.
#[tauri::command]
#[specta::specta]
pub async fn agent_get_local_provider_settings<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AgentLocalProviderSettings, CommandError> {
    blocking("agent_get_local_provider_settings", move || {
        Ok(store(&app).settings())
    })
    .await
}

/// `agent:setLocalProviderSettings`. A non-loopback URL needs `allowNonLoopback`; the key goes to
/// the keychain before the config is written.
#[tauri::command]
#[specta::specta]
pub async fn agent_set_local_provider_settings<R: Runtime>(
    app: AppHandle<R>,
    input: AgentLocalProviderSettingsUpdate,
) -> Result<AgentLocalProviderSettings, CommandError> {
    blocking("agent_set_local_provider_settings", move || {
        store(&app).write(input).map_err(|error| {
            let error = store_error(&app, error);
            log_failure("agent_set_local_provider_settings", &error);
            error
        })
    })
    .await
}

/// `agent:listLocalModels`. An unreachable server is an empty list, as in Electron.
#[tauri::command]
#[specta::specta]
pub async fn agent_list_local_models<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AgentLocalModelList, CommandError> {
    let provider = read(&app, "agent_list_local_models").await?;
    let models = probe::list_models(&client(), &provider)
        .await
        .unwrap_or_else(|reason| {
            tracing::warn!(
                scope = SCOPE,
                "local provider model listing failed: {reason}"
            );
            Vec::new()
        });
    Ok(AgentLocalModelList { models })
}

/// `agent:testLocalProvider`: the server answers `GET /models` and lists the model.
#[tauri::command]
#[specta::specta]
pub async fn agent_test_local_provider<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AgentLocalProviderProbeResult, CommandError> {
    let provider = read(&app, "agent_test_local_provider").await?;
    Ok(probe::test_connection(&client(), &provider).await)
}

/// `agent:probeLocalProvider`: a live capability probe (streaming and tool calls), never
/// answered from a cache.
#[tauri::command]
#[specta::specta]
pub async fn agent_probe_local_provider<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AgentLocalProviderProbeResult, CommandError> {
    let provider = read(&app, "agent_probe_local_provider").await?;
    Ok(probe::probe(&client(), &provider).await.result)
}
