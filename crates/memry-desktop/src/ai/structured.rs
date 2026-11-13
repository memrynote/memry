//! One structured-output call to the inline AI model, in place of the AI SDK's
//! `generateText({ output: Output.object({ schema }) })` that Electron's writing assist and
//! field fill run (`ai-inline/writing-assist.ts`, `ai-inline/fill-fields.ts`). The request goes
//! through [`AiProxy::call`], so the key is the one Rust read from the keychain, the address is
//! the provider's, and the call ends with its page or the vault.
//!
//! Each provider gets the shape its SDK sends for a JSON schema:
//! - OpenAI: the Responses API with a strict `json_schema` text format (`createOpenAI()(model)`).
//! - Ollama and a custom endpoint: chat completions with a strict `json_schema` response format
//!   (`createOpenAI().chat()` and `createOpenAICompatible({ supportsStructuredOutputs })`).
//!   Electron's writing assist sent Ollama to the Responses API. Ollama serves `/v1/responses`
//!   since v0.13.3 but ignores its `text.format`, so the answer is not held to the schema (the
//!   comment on `buildModel` in `fill-fields.ts`); both calls use chat here.
//! - Anthropic: `output_config.format` on the models the SDK sends it to, else a forced `json`
//!   tool (`@ai-sdk/anthropic` `structuredOutputMode: "auto"`).
//! - Google: `responseMimeType: application/json` with the schema as `responseSchema`.
//!
//! Retries follow the SDK's `maxRetries: 2`: a connection that fails or a 408, 409, 429 or 5xx is
//! tried again after 2 s, then 4 s, or after the provider's `retry-after` when that is shorter
//! than a minute. A vault that closes during the wait ends the call.

use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use super::provider::AiProvider;
use super::proxy::{AiProviderRequest, AiProxy, Answer, HeaderPair, HttpMethod, Owner, ProxyError};
use super::settings::InlineAiSettings;

/// The largest answer read. A proposal list or five alternatives is a few kilobytes.
pub const ANSWER_CAP: usize = 4 * 1024 * 1024;

/// A key shorter than this is not cut out of provider text: cutting a few common characters
/// would garble the message, and the providers' keys are tens of characters long.
const MIN_REDACTED_KEY: usize = 8;

const REDACTED: &str = "[redacted]";

/// What one call asks: the instructions, the user's text and the JSON schema of the answer.
pub struct Ask<'a> {
    pub system: &'a str,
    pub prompt: &'a str,
    pub schema: Value,
}

/// How often and how long to wait between tries.
#[derive(Debug, Clone, Copy)]
pub struct Retry {
    pub retries: u32,
    pub first_delay: Duration,
}

impl Retry {
    /// The AI SDK's defaults.
    pub const SDK: Self = Self {
        retries: 2,
        first_delay: Duration::from_secs(2),
    };
}

/// Why a call gave no object. No message carries the key.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StructuredError {
    /// The request was refused or got no answer (see [`ProxyError`]).
    #[error(transparent)]
    Proxy(ProxyError),
    /// The provider answered with an error status; `message` is its own, else the status.
    #[error("{message}")]
    Status { status: u16, message: String },
    /// The answer held no object of the schema (`NoObjectGeneratedError`).
    #[error("No object generated: {0}")]
    NoObject(String),
    /// The model stopped at its output token limit before the object was whole (Anthropic's
    /// `stop_reason: max_tokens`), as a thinking model does when its thinking takes the budget.
    #[error("No object generated: the model reached its output token limit")]
    OutputLimit,
    /// Every try failed; the last failure (`RetryError`, reason `maxRetriesExceeded`).
    #[error("Failed after {attempts} attempts. Last error: {last}")]
    Retried {
        attempts: u32,
        last: Box<StructuredError>,
    },
    /// A try after the first failed in a way no retry helps (`RetryError`, reason
    /// `errorNotRetryable`).
    #[error("Failed after {attempts} attempts with non-retryable error: '{last}'")]
    NonRetryable {
        attempts: u32,
        last: Box<StructuredError>,
    },
}

/// What the user can fix (`classifyWritingAssistFailure`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// No answer came: the provider is down or the connection failed.
    Unreachable,
    /// The provider refused the key (401 or 403).
    Unauthorized,
    /// The call ended with its page or the vault.
    Ended,
    Other,
}

impl StructuredError {
    pub fn failure(&self) -> Failure {
        match self {
            Self::Retried { last, .. } | Self::NonRetryable { last, .. } => last.failure(),
            Self::Proxy(ProxyError::Unreachable { .. } | ProxyError::BrokeOff(_)) => {
                Failure::Unreachable
            }
            Self::Proxy(ProxyError::Cancelled | ProxyError::VaultClosed) => Failure::Ended,
            Self::Status {
                status: 401 | 403, ..
            } => Failure::Unauthorized,
            _ => Failure::Other,
        }
    }

    fn retryable(&self) -> bool {
        match self {
            Self::Proxy(ProxyError::Unreachable { .. }) => true,
            Self::Status { status, .. } => matches!(status, 408 | 409 | 429 | 500..),
            _ => false,
        }
    }
}

/// Asks the model of `settings` for an object of `ask.schema` and parses it as `T`.
pub async fn generate<T: DeserializeOwned>(
    proxy: &Arc<AiProxy>,
    settings: &InlineAiSettings,
    owner: &Owner,
    ask: &Ask<'_>,
    retry: Retry,
) -> Result<T, StructuredError> {
    let dialect = Dialect::of(settings);
    let (path, body) = dialect.request(&settings.model, ask);
    let body = body.to_string();
    let mut delay = retry.first_delay;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let request = AiProviderRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            provider: settings.provider,
            method: HttpMethod::Post,
            path: path.clone(),
            headers: vec![HeaderPair {
                name: "content-type".to_owned(),
                value: "application/json".to_owned(),
            }],
            body: Some(body.clone()),
        };
        let (error, wait) = match proxy.call(settings, request, owner, ANSWER_CAP).await {
            Ok(answer) if (200..300).contains(&answer.status) => {
                return dialect.object(&answer.body);
            }
            Ok(answer) => {
                let wait = retry_after(&answer.headers)
                    .filter(|ms| *ms < 60_000.0 || *ms < delay.as_secs_f64() * 1000.0);
                (status_error(&answer, settings), wait)
            }
            Err(error) => (StructuredError::Proxy(error), None),
        };
        if !error.retryable() || attempt > retry.retries {
            let (attempts, last) = (attempt, Box::new(error));
            return Err(match *last {
                error if attempt == 1 => error,
                _ if last.retryable() => StructuredError::Retried { attempts, last },
                _ => StructuredError::NonRetryable { attempts, last },
            });
        }
        let pause = wait.map_or(delay, |ms| Duration::from_secs_f64(ms / 1000.0));
        tracing::info!(
            scope = "AIStructured",
            "{} answered {error}; try {} in {} ms",
            settings.provider.name(&settings.base_url),
            attempt + 1,
            pause.as_millis()
        );
        // The next try would send the closed vault's key and text.
        tokio::select! {
            () = owner.vault_closed() => {
                return Err(StructuredError::Proxy(ProxyError::VaultClosed));
            }
            () = tokio::time::sleep(pause) => {}
        }
        delay *= 2;
    }
}

/// The wait a provider asked for, in ms: `retry-after-ms`, else `retry-after` in seconds.
/// An HTTP date is not read; the backoff applies.
fn retry_after(headers: &[HeaderPair]) -> Option<f64> {
    let header = |name: &str| {
        headers
            .iter()
            .find(|pair| pair.name.eq_ignore_ascii_case(name))
            .and_then(|pair| pair.value.trim().parse::<f64>().ok())
    };
    header("retry-after-ms")
        .or_else(|| header("retry-after").map(|seconds| seconds * 1000.0))
        .filter(|ms| ms.is_finite() && *ms >= 0.0)
}

/// The provider's own error message (`error.message`, or `error` as text), else the status. A
/// provider that quotes the key back has it cut out: the message reaches the log and the UI.
fn status_error(answer: &Answer, settings: &InlineAiSettings) -> StructuredError {
    let body: Option<Value> = serde_json::from_slice(&answer.body).ok();
    let error = body.as_ref().and_then(|body| body.get("error"));
    let message = error
        .and_then(|error| error.get("message").or(Some(error)))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            reqwest::StatusCode::from_u16(answer.status)
                .ok()
                .and_then(|status| status.canonical_reason())
                .unwrap_or("the provider refused the request")
                .to_owned()
        });
    StructuredError::Status {
        status: answer.status,
        message: redact(message, settings),
    }
}

/// `message` without the key of `settings`, as sent and as a JSON string escapes it. A provider
/// that never got the key cannot quote it.
fn redact(message: String, settings: &InlineAiSettings) -> String {
    let key = settings.api_key.as_str();
    if !settings.provider.takes_key() || key.chars().count() < MIN_REDACTED_KEY {
        return message;
    }
    let quoted = Value::from(key).to_string();
    let escaped = &quoted[1..quoted.len() - 1];
    message.replace(escaped, REDACTED).replace(key, REDACTED)
}

/// The request and answer shape of each provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Responses,
    Chat,
    Anthropic(AnthropicModel),
    Google,
}

impl Dialect {
    pub fn of(settings: &InlineAiSettings) -> Self {
        match settings.provider {
            AiProvider::Openai => Self::Responses,
            AiProvider::Ollama | AiProvider::Custom => Self::Chat,
            AiProvider::Anthropic => Self::Anthropic(anthropic_model(&settings.model)),
            AiProvider::Google => Self::Google,
        }
    }

    /// The path under the provider's base and the JSON body.
    pub fn request(self, model: &str, ask: &Ask<'_>) -> (String, Value) {
        match self {
            Self::Responses => (
                "/responses".to_owned(),
                json!({
                    "model": model,
                    "instructions": ask.system,
                    "input": [{ "role": "user", "content": ask.prompt }],
                    "text": { "format": {
                        "type": "json_schema",
                        "name": "response",
                        "strict": true,
                        "schema": ask.schema,
                    } },
                }),
            ),
            Self::Chat => (
                "/chat/completions".to_owned(),
                json!({
                    "model": model,
                    "messages": [
                        { "role": "system", "content": ask.system },
                        { "role": "user", "content": ask.prompt },
                    ],
                    "response_format": { "type": "json_schema", "json_schema": {
                        "name": "response",
                        "strict": true,
                        "schema": ask.schema,
                    } },
                }),
            ),
            Self::Anthropic(AnthropicModel {
                output_format,
                max_tokens,
            }) => {
                let mut body = json!({
                    "model": model,
                    "max_tokens": max_tokens,
                    "system": ask.system,
                    "messages": [{ "role": "user", "content": ask.prompt }],
                });
                let extra = if output_format {
                    json!({ "output_config": { "format": {
                        "type": "json_schema",
                        "schema": ask.schema,
                    } } })
                } else {
                    json!({
                        "tools": [{
                            "name": "json",
                            "description": "Respond with a JSON object.",
                            "input_schema": ask.schema,
                        }],
                        "tool_choice": { "type": "tool", "name": "json" },
                    })
                };
                merge(&mut body, extra);
                ("/messages".to_owned(), body)
            }
            Self::Google => {
                let model = if model.contains('/') {
                    model.to_owned()
                } else {
                    format!("models/{model}")
                };
                (
                    format!("/{model}:generateContent"),
                    json!({
                        "systemInstruction": { "parts": [{ "text": ask.system }] },
                        "contents": [{ "role": "user", "parts": [{ "text": ask.prompt }] }],
                        "generationConfig": {
                            "responseMimeType": "application/json",
                            "responseSchema": openapi_schema(&ask.schema),
                        },
                    }),
                )
            }
        }
    }

    /// The object of a provider's answer `body`.
    pub fn object<T: DeserializeOwned>(self, body: &[u8]) -> Result<T, StructuredError> {
        let no_object = |why: &str| StructuredError::NoObject(why.to_owned());
        let body: Value = serde_json::from_slice(body)
            .map_err(|_| no_object("the provider's answer is not JSON"))?;
        let text = self.text(&body);
        if let Some(object) = text
            .as_deref()
            .and_then(|text| serde_json::from_str(text).ok())
        {
            return Ok(object);
        }
        if matches!(self, Self::Anthropic(_))
            && body.get("stop_reason") == Some(&json!("max_tokens"))
        {
            return Err(StructuredError::OutputLimit);
        }
        Err(no_object(if text.is_none() {
            "the answer holds no text"
        } else {
            "could not parse the response"
        }))
    }

    /// The answer's text, which holds the object; `None` when there is none (a refusal).
    pub fn text(self, body: &Value) -> Option<String> {
        let joined = |parts: Vec<&str>| (!parts.is_empty()).then(|| parts.concat());
        match self {
            Self::Responses => joined(
                items(body.get("output"))
                    .filter(|item| item.get("type") == Some(&json!("message")))
                    .flat_map(|item| items(item.get("content")))
                    .filter(|part| part.get("type") == Some(&json!("output_text")))
                    .filter_map(|part| part.get("text")?.as_str())
                    .collect(),
            ),
            Self::Chat => body
                .pointer("/choices/0/message/content")?
                .as_str()
                .map(str::to_owned),
            Self::Anthropic(AnthropicModel {
                output_format: true,
                ..
            }) => joined(
                items(body.get("content"))
                    .filter(|part| part.get("type") == Some(&json!("text")))
                    .filter_map(|part| part.get("text")?.as_str())
                    .collect(),
            ),
            Self::Anthropic(AnthropicModel {
                output_format: false,
                ..
            }) => items(body.get("content"))
                .find(|part| {
                    part.get("type") == Some(&json!("tool_use"))
                        && part.get("name") == Some(&json!("json"))
                })
                .and_then(|part| part.get("input"))
                .map(Value::to_string),
            Self::Google => joined(
                items(body.pointer("/candidates/0/content/parts"))
                    .filter(|part| part.get("thought") != Some(&json!(true)))
                    .filter_map(|part| part.get("text")?.as_str())
                    .collect(),
            ),
        }
    }
}

fn items(value: Option<&Value>) -> impl Iterator<Item = &Value> {
    value.and_then(Value::as_array).into_iter().flatten()
}

fn merge(into: &mut Value, extra: Value) {
    if let (Value::Object(into), Value::Object(extra)) = (into, extra) {
        into.extend(extra);
    }
}

/// What `@ai-sdk/anthropic`'s `getModelCapabilities` gives a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnthropicModel {
    /// Its `auto` mode sends `output_config.format` instead of the `json` tool.
    pub output_format: bool,
    /// `maxOutputTokens`, which the SDK sends as `max_tokens` when the call names none.
    pub max_tokens: u32,
}

/// `getModelCapabilities` of `@ai-sdk/anthropic` 3.0.142, its table in its order: the first
/// name `model` contains wins, then the legacy models, then any other `claude-` model, then a
/// model id it does not know.
pub fn anthropic_model(model: &str) -> AnthropicModel {
    const NAMED: [(&[&str], bool, u32); 13] = [
        (&["claude-sonnet-5-5"], true, 128_000),
        (&["claude-opus-5-5"], true, 128_000),
        (&["claude-haiku-5-5"], true, 128_000),
        (&["claude-opus-5"], true, 128_000),
        (&["claude-fable-5-2", "claude-fable-5-1"], true, 128_000),
        (&["claude-fable-5"], true, 128_000),
        (
            &["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"],
            true,
            128_000,
        ),
        (&["claude-sonnet-4-6", "claude-opus-4-6"], true, 128_000),
        (
            &["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
            true,
            64_000,
        ),
        (&["claude-opus-4-1"], true, 32_000),
        (&["claude-sonnet-4-"], false, 64_000),
        (&["claude-opus-4-"], false, 32_000),
        (&["claude-3-haiku"], false, 4096),
    ];
    let (output_format, max_tokens) = NAMED
        .iter()
        .find(|(names, ..)| names.iter().any(|name| model.contains(name)))
        .map_or_else(
            || {
                if legacy_claude(model) {
                    (false, 4096)
                } else if model.contains("claude-") {
                    (true, 128_000)
                } else {
                    (false, 4096)
                }
            },
            |&(_, output_format, max_tokens)| (output_format, max_tokens),
        );
    AnthropicModel {
        output_format,
        max_tokens,
    }
}

/// `/claude-(?:instant(?:-|$)|v?2(?=$|[-.:])|3(?=$|[-.]))/` of the SDK's table.
fn legacy_claude(model: &str) -> bool {
    model.match_indices("claude-").any(|(at, prefix)| {
        let rest = &model[at + prefix.len()..];
        let next_is = |rest: &str, ends: &[char]| match rest.chars().next() {
            None => true,
            Some(c) => ends.contains(&c),
        };
        if let Some(rest) = rest.strip_prefix("instant") {
            return next_is(rest, &['-']);
        }
        let two = rest.strip_prefix("v2").or_else(|| rest.strip_prefix('2'));
        if let Some(rest) = two {
            return next_is(rest, &['-', '.', ':']);
        }
        rest.strip_prefix('3')
            .is_some_and(|rest| next_is(rest, &['-', '.']))
    })
}

/// The schema as Google's `responseSchema` takes it (`convertJSONSchemaToOpenAPISchema`): an
/// OpenAPI subset without `additionalProperties` or `$schema`. The schemas sent here are plain
/// objects, arrays and strings.
fn openapi_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !matches!(key.as_str(), "additionalProperties" | "$schema"))
                .map(|(key, value)| (key.clone(), openapi_schema(value)))
                .collect::<Map<_, _>>(),
        ),
        Value::Array(list) => Value::Array(list.iter().map(openapi_schema).collect()),
        other => other.clone(),
    }
}
