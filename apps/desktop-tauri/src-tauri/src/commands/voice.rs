//! Voice transcription settings (`settings-handlers.ts:856-990`): the Whisper model's status and
//! download, recording readiness, the OpenAI key, and the OS microphone privacy pane. The
//! `voiceTranscription` group itself is read and written through `settings_get_group`. The local
//! engine (whisper.cpp in the `memry-ml-worker` sidecar, on its own child) is managed here too, so
//! the status reports it loaded and the `stop-utility-processes` step ends it. Transcription
//! itself: dictation (`inbox:transcribe-audio`, a binary command) and a voice memo's retry
//! (`inbox:retry-transcription`).

use std::sync::Arc;

use memry_desktop::http;
use memry_desktop::i18n::{self, Args};
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::locale::LocaleService;
use memry_desktop::paths::{AppPaths, DEVICE_VAR};
use memry_desktop::seams::secure_store::{DeviceIdentityStore, KeyringStore};
use memry_desktop::services::voice::engine::{self, LocalEngine};
use memry_desktop::services::voice::key::OpenAiKey;
use memry_desktop::services::voice::model::{VoiceModel, VoiceModelStatus};
use memry_desktop::services::voice::openai::{self, OpenAi};
use memry_desktop::services::voice::service::{
    MAX_AUDIO_BYTES, Progress, TranscriptionResult, VoiceService,
};
use memry_desktop::services::voice::{self, VoiceProvider, VoiceRecordingReadiness, VoiceSettings};
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use serde::{Deserialize, Serialize};
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, Runtime, Wry};
use tauri_plugin_opener::OpenerExt;

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use super::settings::map_error;
use crate::binary;
use crate::events::{VoiceModelProgressEvent, broadcast};
use crate::shutdown::ShutdownService;
use crate::startup::{self, Stage};

/// The voice model and the transcription service (with its engine and key), one per app.
pub struct Voice {
    model: VoiceModel,
    service: Arc<VoiceService>,
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "manage voice", manage);
}

/// After `manage settings`, whose keychain it shares.
fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let device = app.state::<LaunchEnv>().get(DEVICE_VAR).map(str::to_owned);
    let keychain = app.state::<Arc<KeyringStore>>().inner().clone();
    let model = VoiceModel::new(&app.state::<AppPaths>().data_dir);
    // As `manage ml worker`, a path that cannot be resolved does not fail the launch: the engine
    // then fails each transcription with the reason and never spawns a worker.
    let engine = match crate::ml_worker::worker_paths(app) {
        Ok(paths) => LocalEngine::new(&paths, model.model_path(), engine::limits()),
        Err(error) => {
            tracing::error!(scope = "Voice", "no transcription worker this run: {error}");
            LocalEngine::without_worker(
                model.model_path(),
                format!("the transcription worker was not found: {error}"),
            )
        }
    };
    let openai = OpenAi::new(
        http::client(),
        openai::ENDPOINT,
        app.state::<LaunchEnv>().get(openai::MODEL_VAR),
    );
    let key = OpenAiKey::new(keychain, device.as_deref());
    let voice = Arc::new(Voice {
        model,
        service: VoiceService::new(engine, key, openai),
    });
    let stopping = voice.clone();
    app.state::<ShutdownService>()
        .register(
            "stop-utility-processes",
            Arc::new(move |_, _| {
                let voice = stopping.clone();
                voice.model.stop();
                // Killing the child fails a transcription in flight at once.
                Box::pin(async move {
                    tauri::async_runtime::spawn_blocking(move || voice.service.engine().stop())
                        .await
                        .map_err(|error| error.to_string())
                })
            }),
        )
        .map_err(|error| {
            CommandError::new(ErrorKind::Internal, "shutdown_step", error.to_string())
        })?;
    app.manage(voice);
    Ok(())
}

fn voice<R: Runtime>(app: &AppHandle<R>) -> Arc<Voice> {
    app.state::<Arc<Voice>>().inner().clone()
}

fn key_error(what: &str, error: impl std::fmt::Display) -> CommandError {
    // `voice-transcription-keychain.ts`: "Failed to read/store voice transcription API key".
    CommandError::new(
        ErrorKind::SecureStore,
        "voice_key_failed",
        format!("Failed to {what} voice transcription API key: {error}"),
    )
}

/// `settings:getVoiceModelStatus`.
#[tauri::command]
#[specta::specta]
pub async fn settings_get_voice_model_status(
    app: AppHandle<Wry>,
) -> Result<VoiceModelStatus, CommandError> {
    let voice = voice(&app);
    blocking("settings_get_voice_model_status", move || {
        Ok(voice.model.status(voice.service.engine()))
    })
    .await
}

/// `settings:downloadVoiceModel`: downloads and verifies Whisper Small, with progress on
/// `VoiceModelProgressEvent`. A failure rejects with the download's reason.
#[tauri::command]
#[specta::specta]
pub async fn settings_download_voice_model(app: AppHandle<Wry>) -> Result<(), CommandError> {
    let voice = voice(&app);
    let progress = |event| broadcast(&app, VoiceModelProgressEvent::from(event));
    voice
        .model
        .download(voice.service.engine(), &progress)
        .await
        .map_err(|error| {
            let error = CommandError::new(
                ErrorKind::Transport,
                "voice_model_download_failed",
                error.to_string(),
            );
            log_failure("settings_download_voice_model", &error);
            error
        })
}

/// `settings:getVoiceRecordingReadiness`.
#[tauri::command]
#[specta::specta]
pub async fn settings_get_voice_recording_readiness(
    app: AppHandle<Wry>,
) -> Result<VoiceRecordingReadiness, CommandError> {
    let (voice, settings) = (voice(&app), app.state::<SettingsService>().inner().clone());
    let vault = app.state::<Session>().current();
    blocking("settings_get_voice_recording_readiness", move || {
        let group = settings
            .read_group(vault.as_ref(), "voiceTranscription")
            .map_err(map_error)?;
        voice::readiness(
            VoiceProvider::of_group(&group.value),
            voice.model.downloaded(),
            || {
                voice
                    .service
                    .key()
                    .has_key()
                    .map_err(|error| key_error("read", error))
            },
        )
    })
    .await
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOpenAiKeyStatus {
    pub has_api_key: bool,
}

/// `settings:getVoiceTranscriptionOpenAIKeyStatus`.
#[tauri::command]
#[specta::specta]
pub async fn settings_get_voice_transcription_openai_key_status(
    app: AppHandle<Wry>,
) -> Result<VoiceOpenAiKeyStatus, CommandError> {
    let voice = voice(&app);
    blocking(
        "settings_get_voice_transcription_openai_key_status",
        move || {
            let has_api_key = voice
                .service
                .key()
                .has_key()
                .map_err(|error| key_error("read", error))?;
            Ok(VoiceOpenAiKeyStatus { has_api_key })
        },
    )
    .await
}

/// `settings:setVoiceTranscriptionOpenAIKey`: a blank key deletes the stored one.
#[tauri::command]
#[specta::specta]
pub async fn settings_set_voice_transcription_openai_key(
    app: AppHandle<Wry>,
    api_key: String,
) -> Result<(), CommandError> {
    let voice = voice(&app);
    blocking("settings_set_voice_transcription_openai_key", move || {
        voice
            .service
            .key()
            .set(&api_key)
            .map_err(|error| key_error("store", error))
    })
    .await
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenSettingsResult {
    pub success: bool,
}

/// The OS microphone privacy pane: fixed deep links, never user input, so they bypass the
/// web-link allowlist as Electron's do. Linux has none.
const MICROPHONE_SETTINGS: Option<&str> = if cfg!(target_os = "macos") {
    Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
} else if cfg!(windows) {
    Some("ms-settings:privacy-microphone")
} else {
    None
};

/// `settings:openOsMicrophoneSettings`.
#[tauri::command]
#[specta::specta]
pub async fn settings_open_os_microphone_settings(
    app: AppHandle<Wry>,
) -> Result<OpenSettingsResult, CommandError> {
    let Some(target) = MICROPHONE_SETTINGS else {
        return Ok(OpenSettingsResult { success: false });
    };
    #[cfg(feature = "e2e")]
    if crate::e2e::record_os_open(&app, &format!("url {target}")) {
        return Ok(OpenSettingsResult { success: true });
    }
    app.opener()
        .open_url(target, None::<&str>)
        .map_err(|error| {
            let error = CommandError::new(ErrorKind::Internal, "open_failed", error.to_string());
            log_failure("settings_open_os_microphone_settings", &error);
            error
        })?;
    Ok(OpenSettingsResult { success: true })
}

/// The engine's model load progress, as `settings_download_voice_model` reports it.
fn progress<R: Runtime>(app: &AppHandle<R>) -> Progress {
    let app = app.clone();
    Arc::new(move |event| broadcast(&app, VoiceModelProgressEvent::from(event)))
}

/// The `voiceTranscription` group of the open vault (device-local, so any vault reads the same).
async fn voice_settings<R: Runtime>(
    app: &AppHandle<R>,
    command: &'static str,
) -> Result<VoiceSettings, CommandError> {
    let settings = app.state::<SettingsService>().inner().clone();
    let vault = app.state::<Session>().current();
    blocking(command, move || {
        let group = settings
            .read_group(vault.as_ref(), "voiceTranscription")
            .map_err(map_error)?;
        Ok(VoiceSettings::of_group(&group.value))
    })
    .await
}

/// `TranscribeAudioSchema` without `data`, which is the raw body.
#[derive(Deserialize)]
struct TranscribeMeta {
    format: String,
    duration: Option<f64>,
}

/// Why a dictation request is refused before its body is copied: `TranscribeAudioSchema`'s
/// format and `duration` (0 to 300 s, the recorder's limit), and a body no engine takes.
fn refusal(meta: &TranscribeMeta, len: usize) -> Option<CommandError> {
    let (code, message) = if !matches!(meta.format.as_str(), "webm" | "mp3" | "wav") {
        (
            "voice_format_invalid",
            format!("Unsupported audio format: {}", meta.format),
        )
    } else if meta
        .duration
        .is_some_and(|duration| !(0.0..=300.0).contains(&duration))
    {
        (
            "voice_duration_invalid",
            "A recording lasts at most 300 seconds.".to_owned(),
        )
    } else if len > MAX_AUDIO_BYTES {
        (
            "voice_audio_too_large",
            format!(
                "Audio file too large. Maximum size is {}MB.",
                MAX_AUDIO_BYTES >> 20
            ),
        )
    } else {
        return None;
    };
    Some(CommandError::new(ErrorKind::Invalid, code, message))
}

/// `TranscribeAudioResponse`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeAudioResponse {
    success: bool,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// `inbox:transcribe-audio` (`transcribeAudioInput`): the text in the recording, with no inbox
/// item. Agent Chat dictation. The recording is the raw body and `{ format }` the metadata, so
/// this is a binary command (`binary.rs`).
#[tauri::command]
pub async fn inbox_transcribe_audio<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<TranscribeAudioResponse, CommandError> {
    let meta: TranscribeMeta = binary::meta(&request)?;
    let body = binary::raw_body(&request)?;
    if let Some(error) = refusal(&meta, body.len()) {
        log_failure("inbox_transcribe_audio", &error);
        return Err(error);
    }
    if body.is_empty() {
        return Ok(TranscribeAudioResponse {
            success: false,
            text: String::new(),
            error: Some("Empty audio data".to_owned()),
        });
    }
    let audio = body.to_vec();
    let settings = voice_settings(&app, "inbox_transcribe_audio").await?;
    let outcome = voice(&app)
        .service
        .transcribe(&settings, audio, &meta.format, progress(&app))
        .await;
    Ok(match outcome {
        Ok(text) => TranscribeAudioResponse {
            success: true,
            text,
            error: None,
        },
        Err(error) => {
            tracing::warn!(scope = "Voice", "dictation was not transcribed: {error}");
            TranscribeAudioResponse {
                success: false,
                text: String::new(),
                error: Some(error),
            }
        }
    })
}

/// `inbox:retry-transcription`: transcribes a voice memo again and resolves when it is done.
#[tauri::command]
#[specta::specta]
pub async fn inbox_retry_transcription(
    app: AppHandle<Wry>,
    item_id: String,
) -> Result<TranscriptionResult, CommandError> {
    let open = app.state::<Session>().current().ok_or_else(|| {
        let locale = app.state::<Arc<LocaleService>>().get();
        let message = i18n::t(locale, "errors:ipc.noVaultOpen", &Args::new());
        CommandError::new(ErrorKind::Invalid, "no_vault_open", message)
    });
    // Written under this device's identity, as every inbox write.
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    let inbox = open.and_then(|open| {
        let inbox = open
            .vault
            .inbox(store)
            .map_err(|error| CommandError::from_core(&error))?;
        Ok((inbox, open.path))
    });
    let (inbox, vault) =
        inbox.inspect_err(|error| log_failure("inbox_retry_transcription", error))?;
    let settings = voice_settings(&app, "inbox_retry_transcription").await?;
    Ok(voice(&app)
        .service
        .retry_transcription(inbox, vault, settings, item_id, progress(&app))
        .await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(format: &str, duration: Option<f64>) -> TranscribeMeta {
        TranscribeMeta {
            format: format.to_owned(),
            duration,
        }
    }

    /// `TranscribeAudioSchema`: the formats, a duration in 0..=300 when given, and a body no
    /// engine takes is refused before it is copied.
    #[test]
    fn dictation_refuses_what_the_schema_and_the_engines_refuse() {
        assert!(refusal(&meta("wav", Some(300.0)), MAX_AUDIO_BYTES).is_none());
        assert!(refusal(&meta("webm", None), 1).is_none());
        let refused = |meta: TranscribeMeta, len| refusal(&meta, len).map(|error| error.code);
        assert_eq!(
            refused(meta("flac", None), 1).as_deref(),
            Some("voice_format_invalid")
        );
        assert_eq!(
            refused(meta("wav", Some(300.5)), 1).as_deref(),
            Some("voice_duration_invalid")
        );
        assert_eq!(
            refused(meta("wav", Some(-1.0)), 1).as_deref(),
            Some("voice_duration_invalid")
        );
        assert_eq!(
            refused(meta("wav", None), MAX_AUDIO_BYTES + 1).as_deref(),
            Some("voice_audio_too_large")
        );
    }
}
