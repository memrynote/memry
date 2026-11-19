//! Local agent provider settings (Step 22, #3539): the `agent:*LocalProvider*` and
//! `agent:listLocalModels` channels of Electron's `ipc/agent-handlers.ts`. Each command is one
//! call of `memry_desktop::ai::local_provider`; the key stays in Rust and the renderer learns
//! only whether one is stored. Also the vault's standing tool approvals that Settings lists and
//! revokes, and the arguments of an approval card (Step 28d, #3545).

use std::sync::Arc;

use memry_desktop::agent::runtime::{
    AgentService, ToolCall, edit_vault_trust_list, vault_trust_list,
};
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
use memry_desktop::session::Session;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};

const SCOPE: &str = "AgentLocalProvider";

fn store<R: Runtime>(app: &AppHandle<R>) -> Arc<LocalProviderStore> {
    app.state::<Arc<LocalProviderStore>>().inner().clone()
}

fn store_error<R: Runtime>(app: &AppHandle<R>, error: LocalProviderError) -> CommandError {
    match error {
        LocalProviderError::InvalidUrl => CommandError::new(
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
            CommandError {
                message: keychain_message(app),
                ..CommandError::from_core(&error)
            }
        }
    }
}

fn keychain_message<R: Runtime>(app: &AppHandle<R>) -> String {
    let locale = app.state::<Arc<LocaleService>>().get();
    i18n::t(locale, "errors:ai.keychainUnavailable", &Args::new())
}

/// The settings with the key, read off the async runtime (the keychain call can block). A
/// keychain that cannot answer gives no key and `true`.
async fn read<R: Runtime>(
    app: &AppHandle<R>,
    command: &'static str,
) -> Result<(LocalProvider, bool), CommandError> {
    let app = app.clone();
    blocking(command, move || {
        let (provider, error) = store(&app).read();
        if let Some(error) = &error {
            tracing::warn!(
                scope = SCOPE,
                command,
                "the local provider key could not be read: {error}"
            );
        }
        Ok((provider, error.is_some()))
    })
    .await
}

/// A request sent without the key because the keychain could not answer says so first.
fn with_keychain_detail<R: Runtime>(
    app: &AppHandle<R>,
    mut result: AgentLocalProviderProbeResult,
    keychain_failed: bool,
) -> AgentLocalProviderProbeResult {
    if keychain_failed {
        let message = keychain_message(app);
        result.detail = Some(match result.detail {
            Some(detail) => format!("{message} {detail}"),
            None => message,
        });
    }
    result
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

/// `agent:listLocalModels`. An unreachable server or a keychain that cannot answer is an empty
/// list, as in Electron.
#[tauri::command]
#[specta::specta]
pub async fn agent_list_local_models<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AgentLocalModelList, CommandError> {
    let (provider, keychain_failed) = read(&app, "agent_list_local_models").await?;
    if keychain_failed {
        return Ok(AgentLocalModelList { models: Vec::new() });
    }
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
    let (provider, keychain_failed) = read(&app, "agent_test_local_provider").await?;
    let result = probe::test_connection(&client(), &provider).await;
    Ok(with_keychain_detail(&app, result, keychain_failed))
}

/// `agent:probeLocalProvider`: a live capability probe (streaming and tool calls), never
/// answered from a cache.
#[tauri::command]
#[specta::specta]
pub async fn agent_probe_local_provider<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AgentLocalProviderProbeResult, CommandError> {
    let (provider, keychain_failed) = read(&app, "agent_probe_local_provider").await?;
    let result = probe::probe(&client(), &provider).await.result;
    Ok(with_keychain_detail(&app, result, keychain_failed))
}

/// The open vault's standing tool approvals (`AgentToolGrantsSchema`), for the Settings list.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolGrants {
    pub tools: Vec<String>,
}

/// The vault branch of `EditTrustListRequestSchema`: grants `add`, then revokes `remove`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentVaultTrustEdit {
    #[serde(default)]
    #[specta(optional)]
    pub add: Vec<String>,
    #[serde(default)]
    #[specta(optional)]
    pub remove: Vec<String>,
}

/// `agent:getToolGrants`. No open vault has no grants, as Electron's unavailable handler answers.
#[tauri::command]
#[specta::specta]
pub async fn agent_get_tool_grants<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AgentToolGrants, CommandError> {
    let session = app.state::<Session>();
    let tools = session
        .current()
        .map(|open| vault_trust_list(session.registry().config(), &open.vault_id))
        .unwrap_or_default();
    Ok(AgentToolGrants { tools })
}

/// `agent:editTrustList` with `scope: 'vault'`, which Settings uses to revoke a standing
/// approval. The gate reads the list at every write call, so the revoke holds from the next one.
#[tauri::command]
#[specta::specta]
pub async fn agent_edit_vault_trust_list<R: Runtime>(
    app: AppHandle<R>,
    edit: AgentVaultTrustEdit,
) -> Result<AgentToolGrants, CommandError> {
    blocking("agent_edit_vault_trust_list", move || {
        let session = app.state::<Session>();
        let open = session.current().ok_or_else(|| {
            CommandError::new(ErrorKind::Invalid, "no_vault", "No vault is open.")
        })?;
        let config = session.registry().config();
        edit_vault_trust_list(config, &open.vault_id, &edit.add, &edit.remove)
            .map(|tools| AgentToolGrants { tools })
            .map_err(|error| {
                CommandError::new(ErrorKind::Storage, "agent_prefs_write", error.to_string())
            })
    })
    .await
}

/// `agent_get_tool_call`: the name and arguments of a card on screen, which the all-window
/// `tool_call_pending_approval` event leaves out. A card that settled or belongs to another
/// conversation is `not_found`.
#[tauri::command]
#[specta::specta]
pub async fn agent_get_tool_call<R: Runtime>(
    app: AppHandle<R>,
    conversation_id: String,
    tool_call_id: String,
) -> Result<ToolCall, CommandError> {
    app.try_state::<Arc<AgentService>>()
        .and_then(|service| service.pending_tool_call(&conversation_id, &tool_call_id))
        .ok_or_else(|| {
            CommandError::new(
                ErrorKind::NotFound,
                "agent_tool_call_not_found",
                "No approval is pending for this tool call.",
            )
        })
}
