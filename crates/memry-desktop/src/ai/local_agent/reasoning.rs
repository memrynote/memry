//! The reasoning fields of a chat request (`reasoningProviderOptions` of
//! `local-openai-compatible-backend.ts`). They go out only for a non-default pick, because other
//! OpenAI-compatible servers may reject fields they do not know. The Ollama request carries
//! neither.

use serde_json::{Map, Value, json};

use super::LocalReasoningEffort;
use crate::ai::local_provider::AgentLocalThinking;

/// `reasoning_effort` for a non-default depth, and DeepSeek's `thinking: {"type": "disabled"}`
/// when thinking is off.
pub fn openai_fields(
    effort: LocalReasoningEffort,
    thinking: AgentLocalThinking,
) -> Map<String, Value> {
    let mut fields = Map::new();
    if thinking == AgentLocalThinking::Off {
        fields.insert("thinking".into(), json!({ "type": "disabled" }));
    }
    let effort = match effort {
        LocalReasoningEffort::Default => None,
        LocalReasoningEffort::High => Some("high"),
        LocalReasoningEffort::Max => Some("max"),
    };
    if let Some(effort) = effort {
        fields.insert("reasoning_effort".into(), json!(effort));
    }
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_send_nothing_and_each_pick_sends_its_field() {
        assert!(
            openai_fields(LocalReasoningEffort::Default, AgentLocalThinking::Default).is_empty()
        );
        assert_eq!(
            Value::Object(openai_fields(
                LocalReasoningEffort::Max,
                AgentLocalThinking::Off
            )),
            json!({ "thinking": { "type": "disabled" }, "reasoning_effort": "max" })
        );
    }
}
