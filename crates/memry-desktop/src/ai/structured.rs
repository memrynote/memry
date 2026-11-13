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
//!   Electron's writing assist sent Ollama to the Responses API, which Ollama does not serve
//!   (the comment on `buildModel` in `fill-fields.ts`); both calls use chat here.
//! - Anthropic: `output_config.format` on the models the SDK sends it to, else a forced `json`
//!   tool (`@ai-sdk/anthropic` `structuredOutputMode: "auto"`).
//! - Google: `responseMimeType: application/json` with the schema as `responseSchema`.
//!
//! Retries follow the SDK's `maxRetries: 2`: a connection that fails or a 408, 409, 429 or 5xx is
//! tried again after 2 s, then 4 s, or after the provider's `retry-after` when that is shorter
//! than a minute.

use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use super::provider::AiProvider;
use super::proxy::{AiProviderRequest, AiProxy, Answer, HeaderPair, HttpMethod, Owner, ProxyError};
use super::settings::InlineAiSettings;

/// The largest answer read. A proposal list or five alternatives is a few kilobytes.
pub const ANSWER_CAP: usize = 4 * 1024 * 1024;

/// Anthropic needs an output budget; neither call asks for more than a few hundred tokens.
const ANTHROPIC_MAX_TOKENS: u32 = 4096;

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
    /// Every try failed; the last failure (`RetryError`).
    #[error("Failed after {attempts} attempts. Last error: {last}")]
    Retried {
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
    Other,
}

impl StructuredError {
    pub fn failure(&self) -> Failure {
        match self {
            Self::Retried { last, .. } => last.failure(),
            Self::Proxy(ProxyError::Unreachable { .. }) => Failure::Unreachable,
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
                return parse(dialect, &answer.body);
            }
            Ok(answer) => {
                let wait = retry_after(&answer.headers)
                    .filter(|ms| *ms < 60_000.0 || *ms < delay.as_secs_f64() * 1000.0);
                (status_error(&answer, &settings.api_key), wait)
            }
            Err(error) => (StructuredError::Proxy(error), None),
        };
        if !error.retryable() || attempt > retry.retries {
            return Err(if attempt == 1 {
                error
            } else {
                StructuredError::Retried {
                    attempts: attempt,
                    last: Box::new(error),
                }
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
        tokio::time::sleep(pause).await;
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
fn status_error(answer: &Answer, key: &str) -> StructuredError {
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
    let message = if key.is_empty() {
        message
    } else {
        message.replace(key, "[redacted]")
    };
    StructuredError::Status {
        status: answer.status,
        message,
    }
}

fn parse<T: DeserializeOwned>(dialect: Dialect, body: &[u8]) -> Result<T, StructuredError> {
    let no_object = |why: &str| StructuredError::NoObject(why.to_owned());
    let body: Value =
        serde_json::from_slice(body).map_err(|_| no_object("the provider's answer is not JSON"))?;
    let text = dialect
        .text(&body)
        .ok_or_else(|| no_object("the answer holds no text"))?;
    serde_json::from_str(&text).map_err(|_| no_object("could not parse the response"))
}

/// The request and answer shape of each provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Responses,
    Chat,
    Anthropic { output_format: bool },
    Google,
}

impl Dialect {
    pub fn of(settings: &InlineAiSettings) -> Self {
        match settings.provider {
            AiProvider::Openai => Self::Responses,
            AiProvider::Ollama | AiProvider::Custom => Self::Chat,
            AiProvider::Anthropic => Self::Anthropic {
                output_format: anthropic_output_format(&settings.model),
            },
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
            Self::Anthropic { output_format } => {
                let mut body = json!({
                    "model": model,
                    "max_tokens": ANTHROPIC_MAX_TOKENS,
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
            Self::Anthropic {
                output_format: true,
            } => joined(
                items(body.get("content"))
                    .filter(|part| part.get("type") == Some(&json!("text")))
                    .filter_map(|part| part.get("text")?.as_str())
                    .collect(),
            ),
            Self::Anthropic {
                output_format: false,
            } => items(body.get("content"))
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

/// Whether `@ai-sdk/anthropic`'s `getModelCapabilities` gives `model` structured output, so
/// its `auto` mode sends `output_config.format` instead of the `json` tool. Its table, in its
/// order: the 4.x models named first support it, the other 4.x and the 3.x, 2.x and instant
/// models do not, any other `claude-` model does, and a model id it does not know does not.
pub fn anthropic_output_format(model: &str) -> bool {
    const NATIVE_4: [&str; 8] = [
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "claude-sonnet-4-5",
        "claude-opus-4-5",
        "claude-haiku-4-5",
        "claude-opus-4-1",
    ];
    if NATIVE_4.iter().any(|name| model.contains(name)) {
        return true;
    }
    if ["claude-sonnet-4-", "claude-opus-4-", "claude-3-haiku"]
        .iter()
        .any(|name| model.contains(name))
    {
        return false;
    }
    if legacy_claude(model) {
        return false;
    }
    model.contains("claude-")
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
