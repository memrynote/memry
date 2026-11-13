//! The built-in local agent engine: Electron's `local-openai-compatible-backend.ts`, which ran
//! the AI SDK's `streamText` over `@ai-sdk/openai-compatible` (and `ollama-ai-provider-v2` for
//! the Ollama preset). This port speaks the two wire formats itself: `POST <base>/chat/completions`
//! with server-sent events, and Ollama's native `POST <base without /v1>/api/chat` with NDJSON.
//!
//! A library with no runtime wiring: Step 28 (#3545) drives [`LocalAgent::run`] for chat turns
//! and the fold calls [`LocalAgent::complete_structured`]. Every request goes out on the
//! [`ProbeClient`] (no proxy, no redirects) with the key from [`LocalProviderStore::read`], and no
//! event or log carries the key.

mod error_body;
pub mod images;
pub mod ollama;
pub mod openai;
pub mod probe;
pub mod profile;
pub mod reasoning;
pub mod splitter;
pub mod sse;
mod turn;

use std::sync::Arc;

use futures_util::Stream;
use memry_core::api::errors::SecureStoreError;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::ai::catalog::ProbeClient;
use crate::ai::local_provider::probe::{
    self as provider_probe, AgentLocalProviderProbeResult, AgentToolsOffReason,
};
use crate::ai::local_provider::{LocalProvider, LocalProviderStore};

/// Model calls per turn with tools. The last one runs without tools and asks for a handoff, so a
/// turn cut off at the limit still ends in an answer (AF-032, `STEP_LIMIT` at
/// `local-openai-compatible-backend.ts:52`).
pub const STEP_LIMIT: usize = 24;
/// `STEP_BUDGET_SYSTEM`, the system line of every step with tools.
pub const STEP_BUDGET_SYSTEM: &str = "You can make at most 24 model calls in this turn, and each tool round uses one. Plan the work to fit, and answer before the budget runs out.";
/// `HANDOFF_SYSTEM`, the system line of the last step, which runs without tools.
pub const HANDOFF_SYSTEM: &str = "This is the last model call of this turn: the step limit is reached, and tools are off for this call. Do not write tool calls or tool syntax. Answer in plain text with a short handoff: what is done, what is left, and what the user should send to continue.";
/// The most bytes one step's streamed reply may carry. Text, reasoning and tool-call arguments
/// all accumulate for the next step's request, so an endless reply would grow them without
/// bound; past this the step ends with an error.
pub const STEP_BYTE_BUDGET: usize = 16 * 1024 * 1024;
const SCOPE: &str = "LocalAgent";

/// A tool the model may call: an MCP tool of the vault server in Step 28.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// The JSON schema of the arguments.
    pub input_schema: Value,
}

/// A call the model made, with its parsed arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// An image a tool returned (an MCP image content part), base64 data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolImage {
    pub data: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolError {
    pub code: String,
    pub message: String,
}

/// `AgentToolCallResult` of `tool-bridge.ts`.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolOutcome {
    Ok { data: Value, images: Vec<ToolImage> },
    Err(ToolError),
}

/// Runs the model's tool calls. Step 28 implements it over the vault MCP server with the turn's
/// write grant; a run without a host has no tools.
#[async_trait::async_trait]
pub trait AgentToolHost: Send + Sync {
    fn tool_specs(&self) -> Vec<ToolSpec>;
    async fn call(&self, call: ToolCall) -> ToolOutcome;
}

/// `BackendEvent` of `cli/types.ts`, one to one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum BackendEvent {
    AssistantDelta {
        text: String,
    },
    /// `starts_block` marks the first piece of a new reasoning block.
    ReasoningDelta {
        text: String,
        starts_block: bool,
    },
    ToolUse {
        tool_use_id: String,
        name: String,
        args: Value,
    },
    ToolResult {
        tool_use_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<ToolError>,
    },
    Error {
        message: String,
    },
    /// The provider failed the tool probe, so this turn runs without tool schemas.
    ToolsUnavailable {
        reason: AgentToolsOffReason,
        detail: Option<String>,
    },
    /// The turn used its last allowed model call; that call ran without tools.
    StepLimit,
    MessageStop,
    Noop,
    Unknown {
        raw: Value,
    },
}

/// `LocalReasoningEffort`: a non-default value goes out as `reasoning_effort`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LocalReasoningEffort {
    #[default]
    Default,
    High,
    Max,
}

/// One run: a chat turn (with a host) or a title, summary or structured completion (without).
#[derive(Debug, Clone)]
pub struct LocalRunInput {
    pub prompt: String,
    /// The chat's model; `None` takes the configured one.
    pub model: Option<String>,
    /// `toolsEnabled` of the turn options; `false` runs without tools and without the probe.
    pub tools_enabled: bool,
    pub reasoning_effort: LocalReasoningEffort,
}

impl LocalRunInput {
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            model: None,
            tools_enabled: true,
            reasoning_effort: LocalReasoningEffort::Default,
        }
    }
}

/// Where the engine reads the provider settings and key. [`LocalProviderStore`] in the app.
pub trait ProviderSource: Send + Sync {
    /// The settings with the key; a keychain that cannot answer gives no key and its error.
    fn read(&self) -> (LocalProvider, Option<SecureStoreError>);
}

impl ProviderSource for LocalProviderStore {
    fn read(&self) -> (LocalProvider, Option<SecureStoreError>) {
        LocalProviderStore::read(self)
    }
}

/// A failed [`LocalAgent::complete_structured`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StructuredError {
    #[error("local_openai_compatible failed: {0}")]
    Run(String),
    #[error("{0}")]
    NoJson(&'static str),
    #[error("the model reply does not match the schema: {0}")]
    Schema(String),
}

/// What [`LocalAgent::status`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAgentStatus {
    pub available: bool,
    pub model: String,
}

/// The engine. Cheap to clone; the clones share the probe caches.
#[derive(Clone)]
pub struct LocalAgent {
    inner: Arc<Inner>,
}

struct Inner {
    source: Arc<dyn ProviderSource>,
    client: Arc<ProbeClient>,
    probes: probe::Probes,
}

impl LocalAgent {
    pub fn new(source: Arc<dyn ProviderSource>, client: ProbeClient) -> Self {
        Self {
            inner: Arc::new(Inner {
                source,
                client: Arc::new(client),
                probes: probe::Probes::default(),
            }),
        }
    }

    /// `probeCapabilities`: the settings screen's live probe, never answered from the cache,
    /// which it refreshes.
    pub async fn probe_capabilities(&self) -> AgentLocalProviderProbeResult {
        let provider = self.inner.provider().await;
        self.inner
            .probes
            .resolve(&self.inner.client, &provider, true)
            .await
            .result
    }

    /// `getStatus`: the provider answers and lists the configured model. Live, like Electron's;
    /// the caller caches it. `model` is the configured one, empty for "any".
    pub async fn status(&self) -> LocalAgentStatus {
        let provider = self.inner.provider().await;
        let result = provider_probe::test_connection(&self.inner.client, &provider).await;
        LocalAgentStatus {
            available: result.connected && result.model_available,
            model: provider.model.clone(),
        }
    }

    /// `turnHasTools`: whether the next turn sends tool schemas. The run that follows reuses this
    /// answer instead of probing again.
    pub async fn turn_has_tools(&self, tools_enabled: bool) -> bool {
        if !tools_enabled {
            return false;
        }
        let provider = self.inner.provider().await;
        self.inner
            .probes
            .reserve_for_turn(&self.inner.client, &provider)
            .await
    }

    /// Runs one turn and streams its events. Tools are on only with a host, `tools_enabled` and
    /// a probe that passed. Dropping the stream or cancelling `cancel` stops the request.
    pub fn run(
        &self,
        input: LocalRunInput,
        host: Option<Arc<dyn AgentToolHost>>,
        cancel: CancellationToken,
    ) -> impl Stream<Item = BackendEvent> + Send + 'static {
        turn::stream(self.inner.clone(), input, host, cancel)
    }

    /// `text` without the provider key, for a log line or an error that may quote the provider.
    pub async fn redact(&self, text: String) -> String {
        self.inner.provider().await.redact(text)
    }

    /// `completeStructured`: one run without tools, drained, whose reply must hold one JSON object
    /// that `T` reads (`T` stands in for the zod schema of Electron).
    pub async fn complete_structured<T: DeserializeOwned>(
        &self,
        prompt: &str,
    ) -> Result<T, StructuredError> {
        use futures_util::StreamExt as _;
        let mut input = LocalRunInput::new(prompt);
        input.tools_enabled = false;
        let mut events = std::pin::pin!(self.run(input, None, CancellationToken::new()));
        let mut text = String::new();
        let mut failure = None;
        while let Some(event) = events.next().await {
            match event {
                BackendEvent::AssistantDelta { text: delta } => text.push_str(&delta),
                BackendEvent::Error { message } => failure = failure.or(Some(message)),
                _ => {}
            }
        }
        if let Some(message) = failure {
            return Err(StructuredError::Run(message));
        }
        let object = extract_json_object(&text)?;
        serde_json::from_value(object).map_err(|error| StructuredError::Schema(error.to_string()))
    }
}

impl Inner {
    /// The settings and key. A keychain that cannot answer sends the request without the key: a
    /// keyless server still works, and one that needs the key answers 401.
    async fn provider(&self) -> LocalProvider {
        let source = self.source.clone();
        // The keychain read blocks on the keyring worker (Step 15's 5 s deadline).
        let (provider, error) = match tokio::task::spawn_blocking(move || source.read()).await {
            Ok(read) => read,
            Err(error) => std::panic::resume_unwind(error.into_panic()),
        };
        if let Some(error) = error {
            tracing::warn!(
                scope = SCOPE,
                "the local provider key could not be read, sending without it: {error}"
            );
        }
        provider
    }
}

/// One piece of a streamed step, as the AI SDK's language model stream parts carry it.
#[derive(Debug, Clone, PartialEq)]
enum Part {
    /// `reasoning-start`: a new reasoning block.
    ReasoningStart,
    Reasoning(String),
    Text(String),
    /// A native tool call, its arguments as the JSON text the server sent.
    Call {
        id: String,
        name: String,
        input: String,
    },
    Error(String),
}

/// `extractJsonObject` of `structured-completion.ts`: the first balanced JSON object in `text`,
/// with a code fence or prose around it.
pub fn extract_json_object(text: &str) -> Result<Value, StructuredError> {
    let start = text
        .find('{')
        .ok_or(StructuredError::NoJson("model reply has no JSON object"))?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in text[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    let object = &text[start..=start + offset];
                    return serde_json::from_str(object)
                        .map_err(|error| StructuredError::Schema(error.to_string()));
                }
            }
            _ => {}
        }
    }
    Err(StructuredError::NoJson(
        "model reply has an unterminated JSON object",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_json_object_is_found_inside_a_fence_with_braces_in_strings() {
        let reply = "Here:\n```json\n{\"a\": \"}{\\\"\", \"b\": {\"c\": 1}}\n```";
        assert_eq!(
            extract_json_object(reply).unwrap(),
            serde_json::json!({"a": "}{\"", "b": {"c": 1}})
        );
        assert_eq!(
            extract_json_object("no object"),
            Err(StructuredError::NoJson("model reply has no JSON object"))
        );
        assert!(matches!(
            extract_json_object("{\"a\": 1"),
            Err(StructuredError::NoJson(_))
        ));
    }

    #[test]
    fn the_step_budget_line_names_the_limit() {
        assert!(STEP_BUDGET_SYSTEM.contains(&format!("at most {STEP_LIMIT} model calls")));
    }
}
