//! The transcription pipeline of `transcription.ts`: [`VoiceService::transcribe`] runs the engine
//! the settings pick on audio bytes (`transcribeAudioData`, also dictation's), and
//! [`VoiceService::on_voice_captured`] transcribes a voice memo's file and writes the outcome onto
//! the item (`transcribeAudio`), which Step 27 (#3544)'s job runner calls.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Local;
use memry_core::api::inbox::Inbox;
use memry_ml_worker::MAX_TRANSCRIBE_BYTES;
use serde::Serialize;

use super::engine::LocalEngine;
use super::key::OpenAiKey;
use super::openai::{self, OpenAi};
use super::{VoiceProvider, VoiceSettings, naming};
use crate::embedding::service::ModelProgress;
use crate::vault::paths::open_vault_file;

/// The largest recording an engine takes: the worker's frame cap, which is above OpenAI's 25 MB.
pub const MAX_AUDIO_BYTES: usize = if MAX_TRANSCRIBE_BYTES > openai::MAX_BYTES {
    MAX_TRANSCRIBE_BYTES
} else {
    openai::MAX_BYTES
};

/// Where the local engine reports its model load (`VoiceModelProgressEvent`).
pub type Progress = Arc<dyn Fn(ModelProgress) + Send + Sync>;

/// `TranscriptionResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub transcription: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

impl TranscriptionResult {
    fn failed(error: impl Into<String>) -> Self {
        Self {
            success: false,
            transcription: None,
            error: Some(error.into()),
        }
    }
}

pub struct VoiceService {
    engine: Arc<LocalEngine>,
    key: OpenAiKey,
    openai: OpenAi,
}

impl VoiceService {
    pub fn new(engine: Arc<LocalEngine>, key: OpenAiKey, openai: OpenAi) -> Arc<Self> {
        Arc::new(Self {
            engine,
            key,
            openai,
        })
    }

    pub fn engine(&self) -> &Arc<LocalEngine> {
        &self.engine
    }

    pub fn key(&self) -> &OpenAiKey {
        &self.key
    }

    /// `transcribeAudioData`: the text in `audio`, an `.ext` file, or the reason the user sees.
    /// The local engine takes WAV only; OpenAI takes its formats up to 25 MB and the stored key.
    pub async fn transcribe(
        self: &Arc<Self>,
        settings: &VoiceSettings,
        audio: Vec<u8>,
        ext: &str,
        progress: Progress,
    ) -> Result<String, String> {
        match settings.provider {
            VoiceProvider::Local => {
                if ext != "wav" {
                    return Err(
                        "Local transcription requires WAV voice memos. Record a new \
                                memo or switch to OpenAI."
                            .to_owned(),
                    );
                }
                // Electron's default language when none is set (inv04#15).
                let language = settings.language.clone().unwrap_or_else(|| "en".to_owned());
                let engine = self.engine.clone();
                blocking(move || {
                    engine
                        .transcribe(&audio, &language, &*progress)
                        .map_err(|error| error.to_string())
                })
                .await
            }
            VoiceProvider::OpenAi => {
                OpenAi::check(ext, audio.len())?;
                let this = self.clone();
                let key = blocking(move || {
                    this.key.get().map_err(|error| {
                        format!("Failed to read voice transcription API key: {error}")
                    })
                })
                .await?;
                let Some(key) = key.filter(|key| !key.trim().is_empty()) else {
                    return Err("OpenAI API key not configured in Settings.".to_owned());
                };
                self.openai
                    .transcribe(&key, &audio, ext, settings.language.as_deref())
                    .await
            }
        }
    }

    /// `transcribeAudio`: transcribes the memo's file and writes `processing`, then either the
    /// transcript with `complete` and the name `settings.memo_name_mode` gives, or `failed` with
    /// the reason. `vault` is the root the item's `attachment_path` is relative to.
    pub async fn on_voice_captured(
        self: &Arc<Self>,
        inbox: Arc<Inbox>,
        vault: PathBuf,
        settings: VoiceSettings,
        item_id: String,
        progress: Progress,
    ) -> TranscriptionResult {
        let item = {
            let (inbox, id) = (inbox.clone(), item_id.clone());
            blocking(move || inbox.get(id).map_err(|error| error.to_string())).await
        };
        let item = match item {
            Ok(Some(item)) => item,
            Ok(None) => return TranscriptionResult::failed("Item not found"),
            Err(error) => return TranscriptionResult::failed(error),
        };
        let Some(rel) = item.attachment_path else {
            return TranscriptionResult::failed("No audio file attached to this item");
        };
        if let Err(error) = write(&inbox, move |inbox| {
            inbox.start_transcription(item_id, "processing".to_owned())
        })
        .await
        {
            return TranscriptionResult::failed(error);
        }
        let item_id = item.id;
        let outcome = match blocking(move || read_memo(&vault, &rel)).await {
            Ok((audio, ext)) => self.transcribe(&settings, audio, &ext, progress).await,
            Err(error) => Err(error),
        };
        match outcome {
            Ok(text) => {
                tracing::info!(
                    scope = "Voice",
                    "transcribed a voice memo ({} chars)",
                    text.len()
                );
                let name = naming::memo_name(settings.memo_name_mode, item.created_at_ms, &Local);
                let (id, transcript) = (item_id.clone(), text.clone());
                match write(&inbox, move |inbox| {
                    inbox.complete_transcription(id, transcript, name)
                })
                .await
                {
                    // Stage C2 of Step 24 (#3541) queues the memo's audio embedding here when
                    // `settings.audio_search`.
                    Ok(()) => TranscriptionResult {
                        success: true,
                        transcription: Some(text),
                        error: None,
                    },
                    Err(error) => TranscriptionResult::failed(error),
                }
            }
            Err(error) => {
                tracing::warn!(scope = "Voice", "a voice memo was not transcribed: {error}");
                let reason = error.clone();
                if let Err(write_error) = write(&inbox, move |inbox| {
                    inbox.fail_transcription(item_id, reason)
                })
                .await
                {
                    tracing::error!(
                        scope = "Voice",
                        "the transcription failure was not stored: {write_error}"
                    );
                }
                TranscriptionResult::failed(error)
            }
        }
    }

    /// `retryTranscription`: resets a voice memo to `pending` and transcribes it again.
    pub async fn retry_transcription(
        self: &Arc<Self>,
        inbox: Arc<Inbox>,
        vault: PathBuf,
        settings: VoiceSettings,
        item_id: String,
        progress: Progress,
    ) -> TranscriptionResult {
        let item = {
            let (inbox, id) = (inbox.clone(), item_id.clone());
            blocking(move || inbox.get(id).map_err(|error| error.to_string())).await
        };
        match item {
            Ok(Some(item)) if item.item_type != "voice" => {
                TranscriptionResult::failed("Item is not a voice memo")
            }
            Ok(Some(item)) if item.attachment_path.is_none() => {
                TranscriptionResult::failed("No audio file attached to this item")
            }
            Ok(Some(_)) => {
                let id = item_id.clone();
                if let Err(error) = write(&inbox, move |inbox| {
                    inbox.start_transcription(id, "pending".to_owned())
                })
                .await
                {
                    return TranscriptionResult::failed(error);
                }
                self.on_voice_captured(inbox, vault, settings, item_id, progress)
                    .await
            }
            Ok(None) => TranscriptionResult::failed("Item not found"),
            Err(error) => TranscriptionResult::failed(error),
        }
    }
}

/// The memo's bytes and lowercase extension. The path is synced data, so it opens only under the
/// vault root, and at most what the local worker takes is read.
fn read_memo(vault: &Path, rel: &str) -> Result<(Vec<u8>, String), String> {
    let ext = Path::new(rel)
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let file = open_vault_file(vault, rel)
        .map_err(|error| format!("Audio file not readable: {rel}: {error}"))?
        .ok_or_else(|| format!("Audio file not found: {rel}"))?;
    let mut audio = Vec::new();
    file.take(MAX_AUDIO_BYTES as u64 + 1)
        .read_to_end(&mut audio)
        .map_err(|error| format!("Audio file not readable: {rel}: {error}"))?;
    if audio.len() > MAX_AUDIO_BYTES {
        return Err(format!(
            "Audio file too large. Maximum size is {}MB.",
            MAX_AUDIO_BYTES >> 20
        ));
    }
    Ok((audio, ext))
}

async fn write<T>(
    inbox: &Arc<Inbox>,
    edit: impl FnOnce(&Inbox) -> Result<T, memry_core::api::errors::StorageError> + Send + 'static,
) -> Result<(), String>
where
    T: Send + 'static,
{
    let inbox = inbox.clone();
    blocking(move || edit(&inbox).map(|_| ()).map_err(|error| error.to_string())).await
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}
