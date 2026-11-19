//! Voice transcription settings (`settings-handlers.ts:856-990`): the Whisper model's status and
//! download, recording readiness, the OpenAI key, and the OS microphone privacy pane. The
//! `voiceTranscription` group itself is read and written through `settings_get_group`.

use std::sync::Arc;

use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::{AppPaths, DEVICE_VAR};
use memry_desktop::seams::secure_store::KeyringStore;
use memry_desktop::services::voice::key::OpenAiKey;
use memry_desktop::services::voice::model::{VoiceModel, VoiceModelStatus};
use memry_desktop::services::voice::{self, VoiceProvider, VoiceRecordingReadiness};
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use super::settings::map_error;
use crate::events::{VoiceModelProgressEvent, broadcast};
use crate::shutdown::ShutdownService;
use crate::startup::{self, Stage};

/// The voice model and key, one per app.
pub struct Voice {
    model: VoiceModel,
    key: OpenAiKey,
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "manage voice", manage);
}

/// After `manage settings`, whose keychain it shares.
fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let device = app.state::<LaunchEnv>().get(DEVICE_VAR).map(str::to_owned);
    let keychain = app.state::<Arc<KeyringStore>>().inner().clone();
    let voice = Arc::new(Voice {
        model: VoiceModel::new(&app.state::<AppPaths>().data_dir),
        key: OpenAiKey::new(keychain, device.as_deref()),
    });
    let stopping = voice.clone();
    app.state::<ShutdownService>()
        .register(
            "stop-utility-processes",
            Arc::new(move |_, _| {
                stopping.model.stop();
                Box::pin(async { Ok(()) })
            }),
        )
        .map_err(|error| {
            CommandError::new(ErrorKind::Internal, "shutdown_step", error.to_string())
        })?;
    app.manage(voice);
    Ok(())
}

fn voice(app: &AppHandle<Wry>) -> Arc<Voice> {
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
        Ok(voice.model.status())
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
    voice.model.download(&progress).await.map_err(|error| {
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
                    .key
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
                .key
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
            .key
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
