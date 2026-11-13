//! Fake providers for the local agent engine tests: a recording HTTP server, the SSE and NDJSON
//! reply builders, and the DeepSeek fake of Electron's
//! `backends/__tests__/fixtures/deepseek-fake-server.ts`, rule for rule.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use memry_desktop::ai::catalog::ProbeClient;
use serde_json::{Value, json};
use tokio::net::TcpListener;

pub const MODEL: &str = "test-model";
pub const DEEPSEEK_MODEL: &str = "deepseek-v4-flash";
pub const DEEPSEEK_REASONING: &str = "The user wants tags, so call vault_get_tags.";
pub const DEEPSEEK_REPLY: &str = "You have no tags.";
pub const SSE: &str = "text/event-stream";
pub const NDJSON: &str = "application/x-ndjson";
pub const JSON: &str = "application/json";

/// One request as the server saw it. `body` is `Null` for a GET.
#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: Method,
    pub path: String,
    pub auth: Option<String>,
    pub body: Value,
}

impl Recorded {
    pub fn is_stream(&self) -> bool {
        self.body["stream"] == json!(true)
    }

    pub fn has_tool_message(&self) -> bool {
        self.messages().iter().any(|m| m["role"] == "tool")
    }

    pub fn messages(&self) -> Vec<Value> {
        self.body["messages"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    pub fn mentions(&self, text: &str) -> bool {
        self.body["messages"].to_string().contains(text)
    }
}

pub type Reply = (StatusCode, &'static str, String);

pub struct Fake {
    pub base_url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
}

impl Fake {
    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
}

/// Serves `handler` on a loopback port; `base_url` ends in `/v1`.
pub async fn serve(handler: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> Fake {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let handler = Arc::new(handler);
    let recorded = requests.clone();
    let app = Router::new().fallback(
        move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
            let handler = handler.clone();
            let recorded = recorded.clone();
            async move {
                let request = Recorded {
                    method,
                    path: uri.path().to_owned(),
                    auth: headers
                        .get(header::AUTHORIZATION)
                        .map(|value| value.to_str().unwrap().to_owned()),
                    body: serde_json::from_slice(&body).unwrap_or(Value::Null),
                };
                let (status, content_type, text) = handler(&request);
                recorded.lock().unwrap().push(request);
                let response: Response =
                    (status, [(header::CONTENT_TYPE, content_type)], text).into_response();
                response
            }
        },
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    Fake {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        requests,
    }
}

pub fn client() -> ProbeClient {
    let _ = rustls::crypto::ring::default_provider().install_default();
    ProbeClient::new(memry_desktop::http::builder())
}

pub fn json_reply(status: StatusCode, value: Value) -> Reply {
    (status, JSON, value.to_string())
}

pub fn models(model: &str) -> Reply {
    json_reply(
        StatusCode::OK,
        json!({ "object": "list", "data": [{ "id": model }] }),
    )
}

pub fn chunk(delta: Value, finish_reason: Option<&str>) -> Value {
    json!({
        "id": "chatcmpl-1",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": MODEL,
        "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }],
    })
}

pub fn sse(chunks: &[Value]) -> Reply {
    let mut text: String = chunks
        .iter()
        .map(|chunk| format!("data: {chunk}\n\n"))
        .collect();
    text.push_str("data: [DONE]\n\n");
    (StatusCode::OK, SSE, text)
}

/// A one-chunk text answer, SSE or NDJSON.
pub fn answer(text: &str, ollama: bool) -> Reply {
    if ollama {
        let lines = [
            json!({ "model": MODEL, "message": { "role": "assistant", "content": text }, "done": false }),
            json!({ "model": MODEL, "message": { "role": "assistant", "content": "" }, "done_reason": "stop", "done": true }),
        ];
        let body: String = lines.iter().map(|line| format!("{line}\n")).collect();
        return (StatusCode::OK, NDJSON, body);
    }
    sse(&[chunk(
        json!({ "role": "assistant", "content": text }),
        Some("stop"),
    )])
}

/// The non-streamed replies of the tool probe: a native call of the echo tool, then text.
pub fn probe_reply(request: &Recorded) -> Reply {
    let message = if request.has_tool_message() {
        json!({ "role": "assistant", "content": "ok" })
    } else {
        json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "probe-1",
                "type": "function",
                "function": { "name": "memry_probe_echo", "arguments": "{\"text\":\"ok\"}" },
            }],
        })
    };
    json_reply(
        StatusCode::OK,
        json!({ "choices": [{ "index": 0, "message": message }] }),
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DeepSeekTools {
    /// One tool call, then text.
    Once,
    /// A tool call whenever tools are offered.
    Always,
    /// Tools are an error, as with a model without function calling.
    Reject,
}

#[derive(Clone)]
pub struct DeepSeek {
    /// The bearer token the server requires; `None` accepts any request.
    pub api_key: Option<String>,
    pub tools: DeepSeekTools,
    /// `reasoning_effort` values the API accepts.
    pub efforts: Vec<String>,
    pub reply: String,
    /// Echo the request's authorization header in error bodies, as a careless proxy might.
    pub echo_auth: bool,
}

impl Default for DeepSeek {
    fn default() -> Self {
        Self {
            api_key: None,
            tools: DeepSeekTools::Once,
            efforts: vec!["high".into(), "max".into()],
            reply: DEEPSEEK_REPLY.into(),
            echo_auth: false,
        }
    }
}

impl DeepSeek {
    /// The DeepSeek API rules the app broke on (FB-006, #2609) plus the request fields it adds
    /// (#2708). Thinking is on unless the request disables it.
    fn reject_reason(&self, body: &Value) -> Option<String> {
        let thinking = body["thinking"]["type"] != "disabled";
        if let Some(effort) = body.get("reasoning_effort") {
            let effort = effort
                .as_str()
                .map_or_else(|| effort.to_string(), str::to_owned);
            if !self.efforts.contains(&effort) {
                return Some(format!("reasoning_effort {effort} is not supported"));
            }
        }
        let has_tools = body.get("tools").is_some();
        if has_tools && self.tools == DeepSeekTools::Reject {
            return Some("this model does not support function calling".into());
        }
        if thinking && has_tools && body["tool_choice"].is_object() {
            return Some("tool_choice is not supported in thinking mode".into());
        }
        let stripped = body["messages"].as_array().into_iter().flatten().any(|m| {
            m["role"] == "assistant"
                && m.get("tool_calls").is_some()
                && !m["reasoning_content"].is_string()
        });
        (thinking && stripped)
            .then(|| "reasoning_content must be passed back in thinking mode".into())
    }

    fn tool_call(body: &Value) -> Value {
        let names: Vec<&str> = body["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|tool| tool["function"]["name"].as_str().unwrap_or_default())
            .collect();
        let name = if names.contains(&"vault_get_tags") {
            "vault_get_tags"
        } else {
            names.first().copied().unwrap_or_default()
        };
        let rounds = tool_rounds(body);
        let arguments = if name == "memry_probe_echo" {
            "{\"text\":\"ok\"}"
        } else {
            "{}"
        };
        json!({ "id": format!("call_{}", rounds + 1), "type": "function", "function": { "name": name, "arguments": arguments } })
    }

    pub fn handle(&self, request: &Recorded) -> Reply {
        if let Some(key) = &self.api_key
            && request.auth.as_deref() != Some(format!("Bearer {key}").as_str())
        {
            return json_reply(
                StatusCode::UNAUTHORIZED,
                json!({ "error": { "message": "Authentication Fails", "type": "authentication_error" } }),
            );
        }
        if request.method == Method::GET && request.path.ends_with("/models") {
            return models(DEEPSEEK_MODEL);
        }
        let body = &request.body;
        if let Some(reason) = self.reject_reason(body) {
            let auth = if self.echo_auth {
                format!(" ({})", request.auth.clone().unwrap_or_default())
            } else {
                String::new()
            };
            return json_reply(
                StatusCode::BAD_REQUEST,
                json!({ "error": { "message": reason + &auth, "type": "invalid_request_error" } }),
            );
        }
        let thinking = body["thinking"]["type"] != "disabled";
        let has_tools = body.get("tools").is_some();
        let call = (has_tools && (self.tools == DeepSeekTools::Always || tool_rounds(body) == 0))
            .then(|| Self::tool_call(body));
        if !request.is_stream() {
            let mut message = match &call {
                Some(call) => json!({ "role": "assistant", "content": null, "tool_calls": [call] }),
                None => json!({ "role": "assistant", "content": self.reply }),
            };
            if thinking {
                message["reasoning_content"] = json!(DEEPSEEK_REASONING);
            }
            let finish = if call.is_some() { "tool_calls" } else { "stop" };
            return json_reply(
                StatusCode::OK,
                json!({ "choices": [{ "index": 0, "message": message, "finish_reason": finish }] }),
            );
        }
        let mut first = json!({ "role": "assistant", "content": "" });
        if thinking {
            first["reasoning_content"] = json!(DEEPSEEK_REASONING);
        }
        let mut chunks = vec![chunk(first, None)];
        match call {
            Some(mut call) => {
                call["index"] = json!(0);
                chunks.push(chunk(json!({ "tool_calls": [call] }), None));
                chunks.push(chunk(json!({}), Some("tool_calls")));
            }
            None => {
                chunks.push(chunk(json!({ "content": self.reply }), None));
                chunks.push(chunk(json!({}), Some("stop")));
            }
        }
        sse(&chunks)
    }
}

fn tool_rounds(body: &Value) -> usize {
    body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["role"] == "tool")
        .count()
}
