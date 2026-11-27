//! Voice transcription settings: the local Whisper model (`model`), the OpenAI key (`key`), and
//! whether a voice memo can be recorded now (`readiness`), as Electron's
//! `apps/desktop/src/main/inbox/voice-transcription-settings.ts`, and the local engine that
//! transcribes (`engine`, whisper.cpp in the worker). [`service::VoiceService`] picks the local
//! or the OpenAI engine (`openai`) and writes a voice memo's transcript and name (`naming`).

pub mod engine;
pub mod key;
pub mod model;
pub mod naming;
pub mod openai;
pub mod service;

#[cfg(test)]
mod tests;

use serde::Serialize;
use serde_json::{Map, Value};

/// `VoiceTranscriptionSettings.provider`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum VoiceProvider {
    Local,
    OpenAi,
}

impl VoiceProvider {
    /// The provider of a stored `voiceTranscription` group. Core fills the group's defaults, so
    /// anything but `openai` is the default `local`, as Electron's spread over its defaults.
    pub fn of_group(group: &Map<String, Value>) -> Self {
        match group.get("provider").and_then(Value::as_str) {
            Some("openai") => Self::OpenAi,
            _ => Self::Local,
        }
    }
}

/// `VoiceTranscriptionSettings.memoNameMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoNameMode {
    Transcript,
    Timestamp,
    None,
}

/// The `voiceTranscription` group as transcription reads it. As with [`VoiceProvider::of_group`],
/// a value this build does not know reads as the default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceSettings {
    pub provider: VoiceProvider,
    pub memo_name_mode: MemoNameMode,
    /// A Whisper language code, or `None` for the engine's default (`en` locally, detection on
    /// OpenAI).
    pub language: Option<String>,
    /// `audioSearch` is not `false`: a transcribed memo is embedded for audio search.
    pub audio_search: bool,
}

impl VoiceSettings {
    pub fn of_group(group: &Map<String, Value>) -> Self {
        let text = |key| group.get(key).and_then(Value::as_str);
        Self {
            provider: VoiceProvider::of_group(group),
            memo_name_mode: match text("memoNameMode") {
                Some("timestamp") => MemoNameMode::Timestamp,
                Some("none") => MemoNameMode::None,
                _ => MemoNameMode::Transcript,
            },
            language: text("language")
                .filter(|language| !language.is_empty())
                .map(str::to_owned),
            audio_search: group.get("audioSearch") != Some(&Value::Bool(false)),
        }
    }
}

/// Why a recording cannot start (`VoiceRecordingReadiness.reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceNotReady {
    MissingModel,
    MissingApiKey,
}

/// `VoiceRecordingReadiness`. `message` is English, as Electron's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRecordingReadiness {
    pub ready: bool,
    pub provider: VoiceProvider,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub reason: Option<VoiceNotReady>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub message: Option<String>,
}

/// `getVoiceRecordingReadiness`: the local provider needs the downloaded model, the OpenAI
/// provider a stored key. `has_key` is asked only for OpenAI, so a locked keychain never blocks
/// local recording.
pub fn readiness<E>(
    provider: VoiceProvider,
    model_downloaded: bool,
    has_key: impl FnOnce() -> Result<bool, E>,
) -> Result<VoiceRecordingReadiness, E> {
    let blocked = match provider {
        VoiceProvider::Local if model_downloaded => None,
        VoiceProvider::Local => Some((
            VoiceNotReady::MissingModel,
            "Download Whisper Small in Settings to record voice memos.",
        )),
        VoiceProvider::OpenAi if has_key()? => None,
        VoiceProvider::OpenAi => Some((
            VoiceNotReady::MissingApiKey,
            "Add your OpenAI API key in Settings to record voice memos.",
        )),
    };
    Ok(VoiceRecordingReadiness {
        ready: blocked.is_none(),
        provider,
        reason: blocked.map(|(reason, _)| reason),
        message: blocked.map(|(_, message)| message.to_owned()),
    })
}
