//! The OpenAI-compatible wire format: `POST <base>/chat/completions` with `stream: true`, read as
//! server-sent events. The request and the stream reading port `@ai-sdk/openai-compatible`
//! 2.0.81 (`convertToOpenAICompatibleChatMessages`, `prepareTools`, `doStream`).

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::Part;
use super::ToolSpec;
use super::images::{Msg, UserPart};

/// The request body of one step. `tools` is `None` on a step without tools, which then sends no
/// `tool_choice` either.
pub(super) fn request_body(
    model: &str,
    messages: &[Msg<'_>],
    tools: Option<&[ToolSpec]>,
    tool_choice: Option<Value>,
    reasoning: Map<String, Value>,
) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.extend(reasoning);
    body.insert(
        "messages".into(),
        Value::Array(messages.iter().map(message).collect()),
    );
    if let Some(tools) = tools.filter(|tools| !tools.is_empty()) {
        let tools = tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
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

fn message(message: &Msg<'_>) -> Value {
    match message {
        Msg::System(text) => json!({ "role": "system", "content": text }),
        Msg::User(text) => json!({ "role": "user", "content": text }),
        Msg::UserParts(parts) => {
            let content: Vec<Value> = parts
                .iter()
                .map(|part| match part {
                    UserPart::Text(text) => json!({ "type": "text", "text": text }),
                    UserPart::Image(image) => json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{};base64,{}", image.mime_type, image.data) },
                    }),
                })
                .collect();
            json!({ "role": "user", "content": content })
        }
        Msg::Assistant(assistant) => {
            let mut out = Map::new();
            out.insert("role".into(), json!("assistant"));
            let has_calls = !assistant.calls.is_empty();
            out.insert(
                "content".into(),
                if has_calls && assistant.text.is_empty() {
                    Value::Null
                } else {
                    json!(assistant.text)
                },
            );
            if !assistant.reasoning.is_empty() {
                out.insert("reasoning_content".into(), json!(assistant.reasoning));
            }
            if has_calls {
                let calls = assistant
                    .calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": { "name": call.name, "arguments": call.input.to_string() },
                        })
                    })
                    .collect();
                out.insert("tool_calls".into(), Value::Array(calls));
            }
            Value::Object(out)
        }
        Msg::Tool { call_id, content } => {
            json!({ "role": "tool", "tool_call_id": call_id, "content": content })
        }
    }
}

#[derive(Default)]
struct PendingCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

/// Reads the chunks of one streamed reply. Reasoning comes from `reasoning_content` or
/// `reasoning`; a new reasoning block starts after text or a tool call. Tool calls are put
/// together by `index` and handed out at the end.
#[derive(Default)]
pub(super) struct ChunkReader {
    reasoning_active: bool,
    calls: BTreeMap<u64, PendingCall>,
    finished: bool,
}

impl ChunkReader {
    pub fn chunk(&mut self, data: &str) -> Vec<Part> {
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            return vec![Part::Error("Invalid JSON response".to_owned())];
        };
        if let Some(error) = chunk.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The provider streamed an error.");
            return vec![Part::Error(message.to_owned())];
        }
        let Some(choice) = chunk["choices"].get(0) else {
            return Vec::new();
        };
        if !choice["finish_reason"].is_null() {
            self.finished = true;
        }
        let delta = &choice["delta"];
        let mut parts = Vec::new();
        let reasoning = delta["reasoning_content"]
            .as_str()
            .or_else(|| delta["reasoning"].as_str())
            .unwrap_or_default();
        if !reasoning.is_empty() {
            self.reasoning(reasoning, &mut parts);
        }
        match &delta["content"] {
            Value::String(text) if !text.is_empty() => self.text(text, &mut parts),
            Value::Array(items) => {
                for item in items {
                    match (item["type"].as_str(), item["text"].as_str()) {
                        (Some("text"), Some(text)) if !text.is_empty() => {
                            self.text(text, &mut parts);
                        }
                        (Some("thinking"), _) => {
                            if let Some(thinking) = item["thinking"].as_array() {
                                for piece in thinking {
                                    if let Some(text) = piece["thinking"].as_str() {
                                        self.reasoning(text, &mut parts);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        if let Some(deltas) = delta["tool_calls"].as_array().filter(|d| !d.is_empty()) {
            self.reasoning_active = false;
            for (position, call) in deltas.iter().enumerate() {
                let index = call["index"].as_u64().unwrap_or(position as u64);
                let pending = self.calls.entry(index).or_default();
                if let Some(id) = call["id"].as_str() {
                    pending.id.get_or_insert_with(|| id.to_owned());
                }
                let function = &call["function"];
                if let Some(name) = function["name"].as_str() {
                    pending.name.get_or_insert_with(|| name.to_owned());
                }
                if let Some(arguments) = function["arguments"].as_str() {
                    pending.arguments.push_str(arguments);
                }
            }
        }
        parts
    }

    /// The stream ended: the tool calls, and an error when no chunk carried a finish reason.
    pub fn end(&mut self) -> Vec<Part> {
        let mut parts: Vec<Part> = std::mem::take(&mut self.calls)
            .into_values()
            .filter_map(|call| {
                Some(Part::Call {
                    id: call.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    name: call.name?,
                    input: call.arguments,
                })
            })
            .collect();
        if !self.finished {
            parts.push(Part::Error(
                "Response stream ended without a finish reason.".to_owned(),
            ));
        }
        parts
    }

    fn reasoning(&mut self, text: &str, parts: &mut Vec<Part>) {
        if !self.reasoning_active {
            self.reasoning_active = true;
            parts.push(Part::ReasoningStart);
        }
        parts.push(Part::Reasoning(text.to_owned()));
    }

    fn text(&mut self, text: &str, parts: &mut Vec<Part>) {
        self.reasoning_active = false;
        parts.push(Part::Text(text.to_owned()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_are_put_together_by_index_and_reasoning_restarts_after_text() {
        let mut reader = ChunkReader::default();
        let mut parts = Vec::new();
        for data in [
            r#"{"choices":[{"delta":{"reasoning_content":"a"}}]}"#,
            r#"{"choices":[{"delta":{"reasoning":"b","content":"x"}}]}"#,
            r#"{"choices":[{"delta":{"reasoning_content":"c"}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"k","function":{"name":"t","arguments":"{\"a\""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}]}"#,
        ] {
            parts.extend(reader.chunk(data));
        }
        parts.extend(reader.end());
        assert_eq!(
            parts,
            vec![
                Part::ReasoningStart,
                Part::Reasoning("a".into()),
                Part::Reasoning("b".into()),
                Part::Text("x".into()),
                Part::ReasoningStart,
                Part::Reasoning("c".into()),
                Part::Call {
                    id: "k".into(),
                    name: "t".into(),
                    input: "{\"a\":1}".into()
                },
            ]
        );
    }

    #[test]
    fn a_stream_without_a_finish_reason_is_an_error() {
        let mut reader = ChunkReader::default();
        assert_eq!(
            reader.chunk(r#"{"choices":[{"delta":{"content":""}}]}"#),
            vec![]
        );
        assert_eq!(
            reader.end(),
            vec![Part::Error(
                "Response stream ended without a finish reason.".into()
            )]
        );
    }
}
