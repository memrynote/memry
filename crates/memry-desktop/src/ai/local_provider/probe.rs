//! The model list, the connection test and the capability probe of the local provider
//! (`local-provider-probe.ts` of Electron). Every request runs on a [`ProbeClient`] (redirects
//! off) with the key in a sensitive `authorization` header; no message carries the key or the
//! request URL.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::LocalProvider;
use crate::ai::catalog::{self, PROVIDER_TIMEOUT, ProbeClient};
use crate::ai::local_agent::splitter::{Segment, TextToolCallSplitter};
use crate::ai::provider::AiProvider;
use crate::http::read_capped;

/// Long enough for a slow local thinking model to finish the tool probe's two generations.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(120);
const PROBE_TOOL_NAME: &str = "memry_probe_echo";
const PROBE_USER_TEXT: &str = "Call the echo tool with text \"ok\".";
/// The largest chat completion read.
const BODY_CAP: usize = 4 * 1024 * 1024;
/// The largest error body read for the provider's reason.
const ERROR_BODY_CAP: usize = 64 * 1024;

/// `AgentLocalProviderProbeResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLocalProviderProbeResult {
    pub connected: bool,
    pub model_available: bool,
    pub streaming_supported: bool,
    pub tool_calling_supported: bool,
    pub tool_continuation_supported: bool,
    pub tools_enabled: bool,
    pub detail: Option<String>,
}

/// `AgentLocalModelList`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AgentLocalModelList {
    pub models: Vec<String>,
}

/// `AgentToolsOffReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentToolsOffReason {
    ToolsRejected,
    NoToolCall,
    ToolResultRejected,
    StreamingUnsupported,
}

/// `ToolCallProfile.toolChoice`: `Omit` when the provider rejected a named `tool_choice` and
/// only worked without one (DeepSeek in thinking mode, #2609).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolChoice {
    Auto,
    Omit,
}

/// What a probe run decided about tools. `Transient` means the provider failed for a reason
/// unrelated to the model (network, timeout, 408, 429, 5xx), so the run says nothing about tools.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolVerdict {
    On(ToolChoice),
    Off {
        reason: AgentToolsOffReason,
        /// The provider's own error text; `None` when Memry only observed the model.
        detail: Option<String>,
    },
    Unreachable,
    Transient,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeRun {
    pub result: AgentLocalProviderProbeResult,
    pub tools: ToolVerdict,
}

#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: Option<String>,
}

/// `GET <base>/models` with the key: the ids of `data[]`.
pub async fn list_models(
    client: &ProbeClient,
    provider: &LocalProvider,
) -> Result<Vec<String>, String> {
    let base = provider.endpoint().map_err(|error| error.to_string())?;
    let body = catalog::probe(
        client,
        AiProvider::Custom,
        base,
        provider.key(),
        PROVIDER_TIMEOUT,
    )
    .await
    .map_err(|failure| failure.to_string())?;
    let list: ModelList = serde_json::from_slice(&body)
        .map_err(|_| "the provider answered with an unreadable model list".to_owned())?;
    Ok(list
        .data
        .into_iter()
        .filter_map(|entry| entry.id)
        .filter(|id| !id.is_empty())
        .collect())
}

/// `testOpenAiCompatibleConnection`: the server answers and lists the configured model (an
/// empty model takes any list).
pub async fn test_connection(
    client: &ProbeClient,
    provider: &LocalProvider,
) -> AgentLocalProviderProbeResult {
    match list_models(client, provider).await {
        Ok(models) => {
            let model_available = provider.model.is_empty() || models.contains(&provider.model);
            AgentLocalProviderProbeResult {
                connected: true,
                model_available,
                streaming_supported: true,
                detail: (!model_available)
                    .then(|| format!("Model {} was not returned by /v1/models.", provider.model)),
                ..Default::default()
            }
        }
        Err(detail) => AgentLocalProviderProbeResult {
            detail: Some(detail),
            ..Default::default()
        },
    }
}

/// `probeLocalProvider`: connection, then a streamed reply, then a forced tool call and its
/// continuation.
pub async fn probe(client: &ProbeClient, provider: &LocalProvider) -> ProbeRun {
    let connection = test_connection(client, provider).await;
    let base = match provider.endpoint() {
        Ok(base) if connection.connected && connection.model_available => base,
        _ => {
            return ProbeRun {
                result: connection,
                tools: ToolVerdict::Unreachable,
            };
        }
    };
    let chat = Chat {
        client,
        url: format!("{base}/chat/completions"),
        provider,
    };

    if let Err(detail) = chat.streams().await {
        tracing::warn!(scope = "AgentLocalProvider", model = %provider.model, "streaming probe failed: {detail}");
        return ProbeRun {
            result: AgentLocalProviderProbeResult {
                streaming_supported: false,
                tools_enabled: false,
                detail: Some(detail),
                ..connection
            },
            tools: ToolVerdict::Off {
                reason: AgentToolsOffReason::StreamingUnsupported,
                detail: None,
            },
        };
    }

    let result = AgentLocalProviderProbeResult {
        detail: None,
        ..connection
    };
    match chat.tool_probe().await {
        ToolProbe::On(choice) => ProbeRun {
            result: AgentLocalProviderProbeResult {
                tool_calling_supported: true,
                tool_continuation_supported: true,
                tools_enabled: true,
                ..result
            },
            tools: ToolVerdict::On(choice),
        },
        ToolProbe::Transient(detail) => {
            tracing::warn!(scope = "AgentLocalProvider", model = %provider.model, "tool probe hit a transient error, tools stay on: {detail}");
            ProbeRun {
                result: AgentLocalProviderProbeResult {
                    tools_enabled: true,
                    detail: Some(format!(
                        "Tool check hit a temporary provider error, tools stay on: {detail}"
                    )),
                    ..result
                },
                tools: ToolVerdict::Transient,
            }
        }
        ToolProbe::Off {
            reason,
            called,
            detail,
            provider_detail,
        } => {
            tracing::warn!(scope = "AgentLocalProvider", model = %provider.model, "tool probe failed: {detail}");
            ProbeRun {
                result: AgentLocalProviderProbeResult {
                    tool_calling_supported: called,
                    tool_continuation_supported: false,
                    tools_enabled: false,
                    detail: Some(detail),
                    ..result
                },
                tools: ToolVerdict::Off {
                    reason,
                    detail: provider_detail,
                },
            }
        }
    }
}

enum ToolProbe {
    On(ToolChoice),
    Transient(String),
    Off {
        reason: AgentToolsOffReason,
        called: bool,
        detail: String,
        provider_detail: Option<String>,
    },
}

impl ToolProbe {
    fn rejected(reason: AgentToolsOffReason, called: bool, error: ChatError) -> Self {
        if error.transient {
            return Self::Transient(error.detail);
        }
        Self::Off {
            reason,
            called,
            provider_detail: Some(error.detail.clone()),
            detail: error.detail,
        }
    }
}

/// A failed chat request. `transient` per `isTransientError`: no answer, a timeout, or HTTP 408,
/// 429 or 5xx.
struct ChatError {
    transient: bool,
    detail: String,
}

struct Chat<'a> {
    client: &'a ProbeClient,
    url: String,
    provider: &'a LocalProvider,
}

impl Chat<'_> {
    async fn send(&self, body: &Value) -> Result<reqwest::Response, ChatError> {
        let headers = AiProvider::Custom
            .auth_headers(self.provider.key())
            .map_err(|error| ChatError {
                transient: false,
                detail: error.to_string(),
            })?;
        self.client
            .http()
            .post(&self.url)
            .headers(headers)
            .json(body)
            .timeout(PROBE_TIMEOUT)
            .send()
            .await
            .map_err(|error| ChatError {
                transient: !error.is_builder(),
                detail: describe(&error),
            })
    }

    /// `probeStreaming`: the first chunk of a streamed reply arrives.
    async fn streams(&self) -> Result<(), String> {
        let body = json!({
            "model": self.provider.model,
            "stream": true,
            "messages": [{ "role": "user", "content": "Reply with ok." }],
        });
        let mut response = self.send(&body).await.map_err(|error| error.detail)?;
        if !response.status().is_success() {
            return Err(format!(
                "/v1/chat/completions streaming returned HTTP {}",
                response.status().as_u16()
            ));
        }
        match response.chunk().await {
            Ok(Some(chunk)) if !chunk.is_empty() => Ok(()),
            Ok(_) => Err("Streaming response ended before sending a chunk.".to_owned()),
            Err(error) => Err(describe(&error)),
        }
    }

    /// `postChatCompletion`: one non-streamed completion.
    async fn complete(&self, body: &Value) -> Result<Value, ChatError> {
        let response = self.send(body).await?;
        let status = response.status();
        if !status.is_success() {
            let code = status.as_u16();
            let reason = read_capped(response, ERROR_BODY_CAP)
                .await
                .ok()
                .and_then(|body| provider_reason(&body))
                .map_or_else(String::new, |reason| format!(": {reason}"));
            return Err(ChatError {
                transient: code == 408 || code == 429 || code >= 500,
                detail: format!("/v1/chat/completions returned HTTP {code}{reason}"),
            });
        }
        let body = read_capped(response, BODY_CAP)
            .await
            .map_err(|error| ChatError {
                transient: true,
                detail: error.to_string(),
            })?;
        serde_json::from_slice(&body).map_err(|_| ChatError {
            transient: false,
            detail: "/v1/chat/completions answered with unreadable JSON".to_owned(),
        })
    }

    /// `probeToolCalling`: a named call of the echo tool (retried without `tool_choice` when the
    /// provider refuses it), then the tool result sent back.
    async fn tool_probe(&self) -> ToolProbe {
        let tools = json!([{
            "type": "function",
            "function": {
                "name": PROBE_TOOL_NAME,
                "description": "Echo a probe string.",
                "parameters": {
                    "type": "object",
                    "properties": { "text": { "type": "string" } },
                    "required": ["text"],
                    "additionalProperties": false,
                },
            },
        }]);
        let user = json!({ "role": "user", "content": PROBE_USER_TEXT });
        let mut request = json!({
            "model": self.provider.model,
            "messages": [user],
            "tools": tools,
        });
        let mut named = request.clone();
        named["tool_choice"] =
            json!({ "type": "function", "function": { "name": PROBE_TOOL_NAME } });

        let (first, choice) = match self.complete(&named).await {
            Ok(first) => (first, ToolChoice::Auto),
            Err(error) if error.transient => return ToolProbe::Transient(error.detail),
            // DeepSeek in thinking mode answers a named tool_choice with HTTP 400 although it
            // calls tools fine without one (#2609). The chat then sends no tool_choice either.
            Err(_) => match self.complete(&request).await {
                Ok(first) => (first, ToolChoice::Omit),
                Err(error) => {
                    return ToolProbe::rejected(AgentToolsOffReason::ToolsRejected, false, error);
                }
            },
        };

        let assistant = &first["choices"][0]["message"];
        let Some((assistant, call_id)) = native_call(assistant).or_else(|| text_call(assistant))
        else {
            return ToolProbe::Off {
                reason: AgentToolsOffReason::NoToolCall,
                called: false,
                detail: format!("Model did not emit the synthetic {PROBE_TOOL_NAME} tool call."),
                provider_detail: None,
            };
        };

        request["messages"] = json!([
            user,
            assistant,
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": json!({ "ok": true, "data": { "text": "ok" } }).to_string(),
            },
        ]);
        if let Some(object) = request.as_object_mut() {
            object.remove("tools");
        }
        match self.complete(&request).await {
            Ok(second) if is_present(&second["choices"][0]["message"]) => ToolProbe::On(choice),
            Ok(_) => ToolProbe::Off {
                reason: AgentToolsOffReason::ToolResultRejected,
                called: true,
                detail: "Model returned no message after the tool result.".to_owned(),
                provider_detail: None,
            },
            Err(error) => ToolProbe::rejected(AgentToolsOffReason::ToolResultRejected, true, error),
        }
    }
}

/// A JavaScript-truthy JSON value, as Electron's `?.` checks read one.
fn is_present(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// The assistant message as sent, when it carries a native tool call with an id.
fn native_call(assistant: &Value) -> Option<(Value, String)> {
    let id = &assistant["tool_calls"][0]["id"];
    if !is_present(id) {
        return None;
    }
    let id = id.as_str().map_or_else(|| id.to_string(), str::to_owned);
    Some((assistant.clone(), id))
}

/// `textCallReplay`: a call the server left in the reply text, sent back as a structured
/// `tool_calls` entry, which is what the chat sends after the text is parsed.
fn text_call(assistant: &Value) -> Option<(Value, String)> {
    let content = assistant.get("content")?.as_str()?;
    let mut splitter = TextToolCallSplitter::new([PROBE_TOOL_NAME.to_owned()]);
    let mut segments = splitter.push(content);
    segments.extend(splitter.flush());
    let call = segments.iter().find_map(|segment| match segment {
        Segment::Call(call) => Some(call.clone()),
        Segment::Text(_) => None,
    })?;
    let text: String = segments
        .iter()
        .filter_map(|segment| match segment {
            Segment::Text(text) => Some(text.as_str()),
            Segment::Call(_) => None,
        })
        .collect();
    let call_id = "probe-text-call";
    let mut replay = assistant.clone();
    replay["content"] = if text.trim().is_empty() {
        Value::Null
    } else {
        Value::String(text)
    };
    replay["tool_calls"] = json!([{
        "id": call_id,
        "type": "function",
        "function": { "name": call.tool_name, "arguments": call.input },
    }]);
    Some((replay, call_id.to_owned()))
}

/// `providerErrorSuffix`: the reason of an OpenAI-style error body (`{error: {message}}` or
/// `{error: "..."}`); anything else is dropped.
fn provider_reason(body: &[u8]) -> Option<String> {
    let body: Value = serde_json::from_slice(body).ok()?;
    let error = body.get("error")?;
    let message = error
        .as_str()
        .or_else(|| error.get("message").and_then(Value::as_str))?
        .trim();
    (!message.is_empty()).then(|| message.to_owned())
}

/// A request error without its URL.
fn describe(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "the provider did not answer in time".to_owned()
    } else if error.is_connect() {
        "the provider could not be reached".to_owned()
    } else {
        let mut text = error.to_string();
        if let Some(url) = error.url() {
            text = text.replace(url.as_str(), "<url>");
        }
        text
    }
}
