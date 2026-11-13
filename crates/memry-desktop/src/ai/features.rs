//! The AI switches (Electron's `settings/ai-settings.ts`, `getAISettings` and `writeAISettings`):
//! four flat device-local keys, stored as the text Electron's `getSetting` reads (`true`,
//! `false`, `codex_cli`), so a row Step 37 imports reads the same here.

use memry_core::domain::similarity::AI_ENABLED_KEY;
use serde::{Deserialize, Serialize};

use crate::fold::agent::FoldAgentChoice;
use crate::session::OpenVault;
use crate::settings::{SettingsError, SettingsService};

/// `IMAGE_EMBEDDING_SETTING_KEY` of `lib/image-embedding.ts`.
pub const IMAGE_EMBEDDINGS_KEY: &str = "ai.imageEmbeddings";
pub const SUMMARIZE_LONG_NOTES_KEY: &str = "ai.summarizeLongNotes";
pub const SUMMARIZE_AGENT_KEY: &str = "ai.summarizeAgent";

/// `AISettings`. With no vault open it reads as the defaults (`DEFAULT_AI_SETTINGS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub enabled: bool,
    pub image_embeddings: bool,
    pub summarize_long_notes: bool,
    pub summarize_agent: FoldAgentChoice,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            image_embeddings: true,
            summarize_long_notes: false,
            summarize_agent: FoldAgentChoice::Auto,
        }
    }
}

/// `Partial<AISettings>`: an absent field is left as it is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsPatch {
    #[serde(default)]
    #[specta(optional)]
    pub enabled: Option<bool>,
    #[serde(default)]
    #[specta(optional)]
    pub image_embeddings: Option<bool>,
    #[serde(default)]
    #[specta(optional)]
    pub summarize_long_notes: Option<bool>,
    #[serde(default)]
    #[specta(optional)]
    pub summarize_agent: Option<FoldAgentChoice>,
}

impl AiSettingsPatch {
    /// The fields the patch writes, by their renderer name (the `ai.<field>` telemetry names).
    pub fn fields(&self) -> Vec<String> {
        [
            ("enabled", self.enabled.is_some()),
            ("imageEmbeddings", self.image_embeddings.is_some()),
            ("summarizeLongNotes", self.summarize_long_notes.is_some()),
            ("summarizeAgent", self.summarize_agent.is_some()),
        ]
        .into_iter()
        .filter(|&(_, set)| set)
        .map(|(name, _)| name.to_owned())
        .collect()
    }

    /// The note fold reads these three (`refreshNoteFold`).
    pub fn touches_fold(&self) -> bool {
        self.enabled.is_some()
            || self.summarize_long_notes.is_some()
            || self.summarize_agent.is_some()
    }
}

/// `getAISettings`: `ai.enabled` and `ai.imageEmbeddings` are on unless they read `false`,
/// `ai.summarizeLongNotes` is on only when it reads `true`.
pub fn read(
    settings: &SettingsService,
    vault: Option<&OpenVault>,
) -> Result<AiSettings, SettingsError> {
    let text = |key: &str| settings.get_local_text(vault, key);
    Ok(AiSettings {
        enabled: text(AI_ENABLED_KEY)?.as_deref() != Some("false"),
        image_embeddings: text(IMAGE_EMBEDDINGS_KEY)?.as_deref() != Some("false"),
        summarize_long_notes: text(SUMMARIZE_LONG_NOTES_KEY)?.as_deref() == Some("true"),
        summarize_agent: FoldAgentChoice::from_stored(text(SUMMARIZE_AGENT_KEY)?.as_deref()),
    })
}

/// `writeAISettings`, the stored values. The embedding side effects of `enabled` and
/// `imageEmbeddings` belong to Step 23 (#3540); the caller refreshes the fold.
pub fn write(
    settings: &SettingsService,
    vault: Option<&OpenVault>,
    patch: &AiSettingsPatch,
) -> Result<(), SettingsError> {
    let vault = vault.ok_or(SettingsError::NoVault)?;
    let flag = |on: bool| if on { "true" } else { "false" };
    let writes = [
        (AI_ENABLED_KEY, patch.enabled.map(flag)),
        (IMAGE_EMBEDDINGS_KEY, patch.image_embeddings.map(flag)),
        (
            SUMMARIZE_LONG_NOTES_KEY,
            patch.summarize_long_notes.map(flag),
        ),
        (
            SUMMARIZE_AGENT_KEY,
            patch.summarize_agent.map(FoldAgentChoice::as_str),
        ),
    ];
    for (key, text) in writes {
        if let Some(text) = text {
            settings.set_local_text(Some(vault), key, text)?;
        }
    }
    Ok(())
}
