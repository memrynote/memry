//! The one-shot calls to the inline AI model (Step 22, #3539): writing assist
//! (`writing-tools:generate-assist` of Electron's `ipc/writing-tools-handlers.ts`) and the
//! field fill (`tags:fill-status` and `tags:fill-fields` of `ipc/tag-object-handlers.ts`). Each
//! reads the settings with the key in Rust and calls `memry_desktop::ai` through the provider
//! proxy, so the key never reaches the webview and the call ends with its page or the vault.

use std::sync::Arc;

use memry_desktop::ai::fill_fields::{
    self, FieldFillStatus, FillFieldsInput, FillFieldsResult, FillNote, Gate, MAX_CANDIDATES,
};
use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::proxy::{AiProxy, Owner};
use memry_desktop::ai::settings::{InlineAiSettings, InlineAiStore};
use memry_desktop::ai::structured::{Failure, Retry, StructuredError};
use memry_desktop::ai::writing_assist::{self, WritingAssistInput, WritingAssistResult};
use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::read;
use memry_desktop::registry::AppConfig;
use memry_desktop::session::Session;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, Webview};

use super::ai::{settings_error, text};
use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use super::notes::open_vault;
use super::tag_schema::schemas;
use crate::shell::services::telemetry;

fn locale<R: Runtime>(app: &AppHandle<R>) -> &'static str {
    app.state::<Arc<LocaleService>>().get()
}

fn proxy<R: Runtime>(app: &AppHandle<R>) -> Arc<AiProxy> {
    app.state::<Arc<AiProxy>>().inner().clone()
}

/// The settings with the key, read off the async runtime (the keychain call can block).
async fn read_settings<R: Runtime>(
    app: &AppHandle<R>,
    command: &'static str,
) -> Result<InlineAiSettings, CommandError> {
    let app = app.clone();
    blocking(command, move || {
        let vault = app.state::<Session>().current();
        app.state::<Arc<InlineAiStore>>()
            .read(vault.as_ref())
            .map_err(|error| settings_error(locale(&app), error))
    })
    .await
}

fn disclosure_accepted<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<Arc<AppConfig>>()
        .agent()
        .field_fill_disclosure_accepted
}

/// The user-facing text of a failed call (the `switch` in `writing-tools-handlers.ts`).
fn failure_text(locale: &str, settings: &InlineAiSettings, error: &StructuredError) -> String {
    match error.failure() {
        Failure::Unreachable if settings.provider == AiProvider::Ollama => {
            i18n::t(locale, "errors:ai.ollamaUnreachable", &Args::new())
        }
        Failure::Unreachable => text(locale, "errors:ai.providerUnreachable", settings),
        Failure::Unauthorized => text(locale, "errors:ai.apiKeyInvalid", settings),
        Failure::Other => error.to_string(),
    }
}

/// Alternative wordings for a selection from the inline AI model. Never edits the note. A
/// failure is `Invalid` with the translated reason the writing tools show.
#[tauri::command]
#[specta::specta]
pub async fn writing_generate_assist<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    input: WritingAssistInput,
) -> Result<WritingAssistResult, CommandError> {
    let locale = locale(&app);
    let refuse = |code: &str, message: String| CommandError::new(ErrorKind::Invalid, code, message);
    let Some(input) = input.validate() else {
        tracing::warn!(
            scope = "IPC:WritingTools",
            "Rejected a writing assist request with an invalid payload"
        );
        return Err(refuse(
            "ai.writingAssistInvalid",
            i18n::t(locale, "errors:ai.writingAssistInvalid", &Args::new()),
        ));
    };
    let proxy = proxy(&app);
    let owner = proxy.owner(webview.label());
    let settings = read_settings(&app, "writing_generate_assist").await?;
    if !settings.enabled {
        return Err(refuse(
            "ai.inlineDisabled",
            i18n::t(locale, "errors:ai.inlineDisabled", &Args::new()),
        ));
    }
    if settings.provider.needs_key() && settings.api_key.is_empty() {
        return Err(refuse(
            "ai.apiKeyMissing",
            text(locale, "errors:ai.apiKeyMissing", &settings),
        ));
    }
    writing_assist::run(&proxy, &settings, &owner, &input, Retry::SDK)
        .await
        .map_err(|error| {
            tracing::warn!(
                scope = "IPC:WritingTools",
                "Writing assist request failed: {error}"
            );
            let failed = refuse(
                "ai.writingAssistFailed",
                failure_text(locale, &settings, &error),
            );
            log_failure("writing_generate_assist", &failed);
            failed
        })
}

/// Whether "Fill from note" shows, and what the first-run disclosure names. The key itself is
/// only checked for presence.
#[tauri::command]
#[specta::specta]
pub async fn tags_fill_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<FieldFillStatus, CommandError> {
    let settings = read_settings(&app, "tags_fill_status").await?;
    Ok(fill_fields::status(&settings, disclosure_accepted(&app)))
}

/// What the fill sends after the gate, read off the async runtime.
fn gather<R: Runtime>(
    app: &AppHandle<R>,
    input: &FillFieldsInput,
) -> Result<Result<Option<fill_fields::FillAsk>, String>, CommandError> {
    let schemas = schemas(app)?;
    let resolved = schemas
        .resolved_tags()
        .map_err(|error| CommandError::from_core(&error))?;
    let telemetry = telemetry(app);
    let note = match read::get(&open_vault(app)?, &input.note_id, telemetry.as_deref()) {
        Ok(note) => note
            .filter(|note| !note.content_omitted)
            .map(|note| FillNote {
                title: note.title,
                content: note.content,
                header_tags: note.header_tags,
                properties: note.properties,
            }),
        Err(error) => return Ok(Err(error.to_string())),
    };
    Ok(fill_fields::plan(
        note,
        &resolved,
        input.tag.as_deref(),
        |tag| {
            schemas
                .relation_candidates(&resolved, tag, MAX_CANDIDATES)
                .map_err(|error| error.to_string())
        },
    ))
}

/// Proposals for the empty fields of a note's header tags from the inline AI model. Writes
/// nothing but the disclosure's acceptance; a model failure is the `failed` result.
#[tauri::command]
#[specta::specta]
pub async fn tags_fill_fields<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    input: FillFieldsInput,
) -> Result<FillFieldsResult, CommandError> {
    let Some(input) = input.validate() else {
        return Err(CommandError::new(
            ErrorKind::Invalid,
            "invalid_input",
            "a note id and a tag of 1 to 100 characters are required",
        ));
    };
    let proxy = proxy(&app);
    let owner = proxy.owner(webview.label());
    let settings = read_settings(&app, "tags_fill_fields").await?;
    let status = fill_fields::status(&settings, disclosure_accepted(&app));
    match fill_fields::gate(&status, input.accept_disclosure == Some(true)) {
        Gate::Stop(result) => return Ok(result),
        Gate::Go { accept: true } => accept_disclosure(&app).await?,
        Gate::Go { accept: false } => {}
    }
    let ask = {
        let app = app.clone();
        let input = input.clone();
        blocking("tags_fill_fields", move || gather(&app, &input)).await?
    };
    let ask = match ask {
        Ok(Some(ask)) => ask,
        Ok(None) => {
            return Ok(FillFieldsResult::Proposals {
                proposals: Vec::new(),
            });
        }
        Err(message) => return Ok(failed(message)),
    };
    Ok(run_fill(&proxy, &settings, &owner, &ask, locale(&app)).await)
}

async fn accept_disclosure<R: Runtime>(app: &AppHandle<R>) -> Result<(), CommandError> {
    let config = app.state::<Arc<AppConfig>>().inner().clone();
    blocking("tags_fill_fields", move || {
        config
            .set_agent_field("fieldFillDisclosureAccepted", Some(Value::Bool(true)))
            .map_err(|error| {
                CommandError::new(ErrorKind::Storage, "agent_prefs_write", error.to_string())
            })
    })
    .await
}

async fn run_fill(
    proxy: &Arc<AiProxy>,
    settings: &InlineAiSettings,
    owner: &Owner,
    ask: &fill_fields::FillAsk,
    locale: &str,
) -> FillFieldsResult {
    match fill_fields::run(proxy, settings, owner, ask, locale, Retry::SDK).await {
        Ok(proposals) => FillFieldsResult::Proposals { proposals },
        Err(error) => failed(error.to_string()),
    }
}

fn failed(message: String) -> FillFieldsResult {
    tracing::warn!(scope = "IPC:TagObjects", "Field fill failed: {message}");
    FillFieldsResult::Failed { message }
}
