//! Which agent writes a note's summaries (Electron's `note-fold/agent.ts`). `auto` takes the first
//! detected agent in [`FoldAgentChoice::DETECTION_ORDER`]; a chosen agent that is not detected
//! resolves to none (`no_agent`), never to another one.
//!
//! This build detects the local provider only, through the local agent engine
//! ([`LocalAgent::status`], `getStatus` of `local-openai-compatible-backend.ts`). The CLI agents
//! keep their choices, so a vault that picked one reads it back, and resolve to none until the
//! desktop runs them.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;
use tokio::time::Instant;

use super::queue::{FoldBackend, FoldWriter};
use crate::ai::local_agent::LocalAgent;

/// How long a detected agent holds (`DETECTED_TTL_MS`).
pub const DETECTED_TTL: Duration = Duration::from_secs(60);
/// "No agent" holds briefly: connecting one in Settings must show up within seconds
/// (`NONE_TTL_MS`).
pub const NONE_TTL: Duration = Duration::from_secs(5);

/// `ai.summarizeAgent` (`FOLD_AGENT_CHOICES` of `@memry/contracts/note-fold`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum FoldAgentChoice {
    #[default]
    Auto,
    ClaudeCli,
    CodexCli,
    AntigravityCli,
    LocalOpenaiCompatible,
}

impl FoldAgentChoice {
    /// `CANDIDATES`: the CLIs first, the local provider last (it is a network probe).
    pub const DETECTION_ORDER: [Self; 4] = [
        Self::ClaudeCli,
        Self::CodexCli,
        Self::AntigravityCli,
        Self::LocalOpenaiCompatible,
    ];

    /// The stored text, as Electron writes it (`codex_cli`, no JSON quotes).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::ClaudeCli => "claude_cli",
            Self::CodexCli => "codex_cli",
            Self::AntigravityCli => "antigravity_cli",
            Self::LocalOpenaiCompatible => "local_openai_compatible",
        }
    }

    /// `readAgentChoice`: an unknown stored value (a newer build's) reads as `auto`.
    pub fn from_stored(text: Option<&str>) -> Self {
        Self::DETECTION_ORDER
            .into_iter()
            .find(|choice| Some(choice.as_str()) == text)
            .unwrap_or(Self::Auto)
    }

    /// The product name the settings row and "Written by" show; not translated.
    pub fn label(self) -> &'static str {
        match self {
            Self::Auto => "Auto",
            Self::ClaudeCli => "Claude",
            Self::CodexCli => "Codex",
            Self::AntigravityCli => "Antigravity",
            Self::LocalOpenaiCompatible => "Local model",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldAgentOption {
    pub id: FoldAgentChoice,
    pub label: String,
}

/// `FoldAgentStatus`: the detected agents in `auto` order, the user's choice, and the label of
/// the agent a run would use (`None` is `no_agent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldAgentStatus {
    pub choice: FoldAgentChoice,
    pub available: Vec<FoldAgentOption>,
    pub resolved: Option<String>,
}

/// A detected agent and the model a run asks for (`None`: the provider's default).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedAgent {
    pub id: FoldAgentChoice,
    pub model: Option<String>,
}

struct Detection {
    at: Instant,
    generation: u64,
    found: Vec<DetectedAgent>,
}

/// The agent detection and its cache. Callers that ask while a detection runs wait for it and
/// share its answer.
pub struct FoldAgents {
    local: LocalAgent,
    detection: Mutex<Option<Detection>>,
    /// Bumped by [`Self::reset`]; a detection that started before it is not kept.
    generation: AtomicU64,
}

impl FoldAgents {
    pub fn new(local: LocalAgent) -> Self {
        Self {
            local,
            detection: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }

    /// `resetFoldAgentDetection`: the settings or the vault changed, so the next ask detects.
    pub fn reset(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// `resolveFoldAgent`: the agent a run uses for `choice`.
    pub async fn resolve(&self, choice: FoldAgentChoice) -> Option<DetectedAgent> {
        pick(&self.detect().await, choice).cloned()
    }

    /// `getFoldAgentStatus`.
    pub async fn status(&self, choice: FoldAgentChoice) -> FoldAgentStatus {
        let found = self.detect().await;
        FoldAgentStatus {
            choice,
            available: found
                .iter()
                .map(|agent| FoldAgentOption {
                    id: agent.id,
                    label: agent.id.label().to_owned(),
                })
                .collect(),
            resolved: pick(&found, choice).map(|agent| agent.id.label().to_owned()),
        }
    }

    /// `detectAvailable`.
    async fn detect(&self) -> Vec<DetectedAgent> {
        let mut detection = self.detection.lock().await;
        let generation = self.generation.load(Ordering::SeqCst);
        if let Some(cached) = &*detection
            && cached.generation == generation
        {
            let ttl = if cached.found.is_empty() {
                NONE_TTL
            } else {
                DETECTED_TTL
            };
            if cached.at.elapsed() < ttl {
                return cached.found.clone();
            }
        }
        let status = self.local.status().await;
        let found: Vec<DetectedAgent> = status
            .available
            .then(|| DetectedAgent {
                id: FoldAgentChoice::LocalOpenaiCompatible,
                model: (!status.model.is_empty()).then_some(status.model),
            })
            .into_iter()
            .collect();
        *detection = Some(Detection {
            at: Instant::now(),
            generation,
            found: found.clone(),
        });
        found
    }
}

fn pick(found: &[DetectedAgent], choice: FoldAgentChoice) -> Option<&DetectedAgent> {
    match choice {
        FoldAgentChoice::Auto => found.first(),
        choice => found.iter().find(|agent| agent.id == choice),
    }
}

/// `toFoldAgent`: the label, the model the run asks for and the cache's model id
/// (`<agent>:<model or default>`), and the run.
#[async_trait]
impl FoldBackend for FoldAgents {
    async fn writer(&self, choice: FoldAgentChoice) -> Option<FoldWriter> {
        let agent = self.resolve(choice).await?;
        Some(FoldWriter {
            id: agent.id,
            label: agent.id.label().to_owned(),
            model_id: format!(
                "{}:{}",
                agent.id.as_str(),
                agent.model.as_deref().unwrap_or("default")
            ),
            model: agent.model,
        })
    }

    async fn run(&self, writer: &FoldWriter, prompt: &str) -> Result<Value, String> {
        match writer.id {
            FoldAgentChoice::LocalOpenaiCompatible => {
                let model = writer.model.clone();
                match self
                    .local
                    .complete_structured_on::<Value>(prompt, model)
                    .await
                {
                    Ok(reply) => Ok(reply),
                    Err(error) => Err(self.local.redact(error.to_string()).await),
                }
            }
            // Detection finds the local provider only, so no other agent resolves.
            other => Err(format!("{} does not run in this build", other.label())),
        }
    }

    fn forget(&self) {
        self.reset();
    }
}
