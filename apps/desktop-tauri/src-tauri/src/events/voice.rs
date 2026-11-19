//! The local Whisper model's download progress (`settings:voiceModelProgress`).

use memry_desktop::embedding::service::{ModelProgress, Phase};
use serde::Serialize;

/// `VoiceModelProgressEvent.phase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum VoiceModelPhase {
    Downloading,
    Loading,
    Ready,
    Error,
}

/// `{ phase, progress, status }`: `progress` 0 to 100, `status` the English line Electron shows
/// (or the failure's reason on `error`).
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelProgressEvent {
    pub phase: VoiceModelPhase,
    pub progress: u8,
    pub status: String,
}

impl From<ModelProgress> for VoiceModelProgressEvent {
    fn from(event: ModelProgress) -> Self {
        Self {
            phase: match event.phase {
                Phase::Downloading => VoiceModelPhase::Downloading,
                Phase::Loading => VoiceModelPhase::Loading,
                Phase::Ready => VoiceModelPhase::Ready,
                Phase::Error => VoiceModelPhase::Error,
            },
            progress: event.progress,
            status: event.status,
        }
    }
}
