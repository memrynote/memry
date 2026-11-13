//! Ollama's native chat API, the only endpoint that accepts `num_ctx`: `POST <base without
//! /v1>/api/chat`, read as NDJSON. The request and the stream reading port
//! `ollama-ai-provider-v2` 3.6.0 (`convertToOllamaChatMessages`, `buildBaseArgs`,
//! `prepareResponsesTools`, `OllamaStreamProcessor`).

use serde_json::{Map, Value, json};

use super::Part;
use super::ToolSpec;
use super::images::{Msg, UserPart};

/// A fixed 8192-token window fixes #591: Ollama's default context is 4096 and
/// `OLLAMA_NUM_PARALLEL` divides it across slots, so Memry's system prompt and tool schemas
/// overflow and the reply is cut to one token (`OLLAMA_NUM_CTX`).
pub const OLLAMA_NUM_CTX: u32 = 8192;

/// `toOllamaApiBaseUrl`: the stored preset URL points at the `/v1` OpenAI-compatible path.
pub fn chat_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    format!("{}/api/chat", base.strip_suffix("/v1").unwrap_or(base))
}

/// The request body of one step. The provider sends `think: false` unless told otherwise, and
/// the backend never told it, so neither does this.
pub(super) fn request_body(
    model: &str,
    messages: &[Msg<'_>],
    tools: Option<&[ToolSpec]>,
    tool_choice: Option<Value>,
) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert(
        "messages".into(),
        Value::Array(messages.iter().map(message).collect()),
    );
    body.insert("think".into(), json!(false));
    body.insert("options".into(), json!({ "num_ctx": OLLAMA_NUM_CTX }));
    if let Some(tools) = tools.filter(|tools| !tools.is_empty()) {
        let tools = tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": parameters(&tool.input_schema),
                    },
                })
            })
            .collect();
        body.insert("tools".into(), Value::Array(tools));
        if let Some(choice) = tool_choice {
            body.insert("tool_choice".into(), choice);
        }
    }
    body.insert("stream".into(), json!(true));
    Value::Object(body)
}

/// An object schema with no properties gets `required: []`, as the provider sends it.
fn parameters(schema: &Value) -> Value {
    let empty_object = schema["type"] == "object"
        && schema["properties"]
            .as_object()
            .is_some_and(serde_json::Map::is_empty);
    if !empty_object {
        return schema.clone();
    }
    let mut schema = schema.clone();
    schema["required"] = json!([]);
    schema
}

fn message(message: &Msg<'_>) -> Value {
    match message {
        Msg::System(text) => json!({ "role": "system", "content": text }),
        Msg::User(text) => json!({ "role": "user", "content": text }),
        Msg::UserParts(parts) => {
            let text: String = parts
                .iter()
                .filter_map(|part| match part {
                    UserPart::Text(text) => Some(text.as_str()),
                    UserPart::Image(_) => None,
                })
                .collect();
            let images: Vec<&str> = parts
                .iter()
                .filter_map(|part| match part {
                    UserPart::Image(image) => Some(image.data.as_str()),
                    UserPart::Text(_) => None,
                })
                .collect();
            let mut out = json!({ "role": "user", "content": text });
            if !images.is_empty() {
                out["images"] = json!(images);
            }
            out
        }
        Msg::Assistant(assistant) => {
            let mut out = json!({ "role": "assistant", "content": assistant.text });
            if !assistant.reasoning.is_empty() {
                out["thinking"] = json!(assistant.reasoning);
            }
            if !assistant.calls.is_empty() {
                out["tool_calls"] = assistant
                    .calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": { "name": call.name, "arguments": call.input },
                        })
                    })
                    .collect();
            }
            out
        }
        Msg::Tool { call_id, content } => {
            json!({ "role": "tool", "tool_call_id": call_id, "content": content })
        }
    }
}

/// Reads the lines of one streamed reply. Ollama sends each tool call whole.
#[derive(Default)]
pub(super) struct LineReader {
    reasoning_started: bool,
}

impl LineReader {
    pub fn line(&mut self, data: &str) -> Vec<Part> {
        let Ok(line) = serde_json::from_str::<Value>(data) else {
            return vec![Part::Error("Invalid JSON response".to_owned())];
        };
        if let Some(error) = line.get("error").filter(|error| !error.is_null()) {
            let message = error
                .as_str()
                .or_else(|| error["message"].as_str())
                .unwrap_or("The provider streamed an error.");
            return vec![Part::Error(message.to_owned())];
        }
        let message = &line["message"];
        let mut parts = Vec::new();
        if let Some(text) = message["content"].as_str().filter(|text| !text.is_empty()) {
            parts.push(Part::Text(text.to_owned()));
        }
        if let Some(thinking) = message["thinking"].as_str().filter(|text| !text.is_empty()) {
            if !self.reasoning_started {
                self.reasoning_started = true;
                parts.push(Part::ReasoningStart);
            }
            parts.push(Part::Reasoning(thinking.to_owned()));
        }
        for call in message["tool_calls"].as_array().into_iter().flatten() {
            let function = &call["function"];
            let Some(name) = function["name"].as_str() else {
                parts.push(Part::Error(
                    "Expected 'function.name' to be a string.".to_owned(),
                ));
                continue;
            };
            if function["arguments"].is_null() {
                continue;
            }
            parts.push(Part::Call {
                id: call["id"]
                    .as_str()
                    .map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_owned),
                name: name.to_owned(),
                input: function["arguments"].to_string(),
            });
        }
        parts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chat_url_drops_v1_and_any_trailing_slash() {
        assert_eq!(
            chat_url("http://localhost:11434/v1/"),
            "http://localhost:11434/api/chat"
        );
        assert_eq!(
            chat_url("http://localhost:11434"),
            "http://localhost:11434/api/chat"
        );
    }

    #[test]
    fn whole_calls_thinking_once_and_the_server_reason_as_an_error() {
        let mut reader = LineReader::default();
        let parts = reader.line(
            r#"{"message":{"content":"","thinking":"hm","tool_calls":[{"function":{"name":"t","arguments":{"a":1}}}]}}"#,
        );
        assert_eq!(
            parts[..2],
            [Part::ReasoningStart, Part::Reasoning("hm".into())]
        );
        assert!(
            matches!(&parts[2], Part::Call { name, input, .. } if name == "t" && input == "{\"a\":1}")
        );
        assert_eq!(
            reader.line(r#"{"message":{"thinking":"more"}}"#),
            vec![Part::Reasoning("more".into())]
        );
        assert_eq!(
            reader.line(r#"{"error":"model does not support tools"}"#),
            vec![Part::Error("model does not support tools".into())]
        );
    }

    #[test]
    fn a_null_error_is_no_error() {
        assert_eq!(
            LineReader::default().line(r#"{"error":null,"message":{"content":"hi"}}"#),
            vec![Part::Text("hi".into())]
        );
    }
}
