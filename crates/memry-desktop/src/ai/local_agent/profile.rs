//! The tool-call profile replayed on each chat step (`toolCallProfileMiddleware` of
//! `tool-call-profile.ts`): `tool_choice` as the probe proved it works, and tool calls a server
//! leaves in the reply text turned into calls. A partial open tag is held back across deltas, and
//! the calls found in the text follow the text, as the middleware enqueues them at `text-end`.

use std::collections::HashSet;

use serde_json::{Value, json};

use super::splitter::{Segment, TextToolCall, TextToolCallSplitter};
use crate::ai::local_provider::probe::ToolChoice;

/// The `tool_choice` of a step with tools: `auto`, or none for a provider that rejected a named
/// choice (`omit`).
pub fn tool_choice(choice: ToolChoice) -> Option<Value> {
    match choice {
        ToolChoice::Auto => Some(json!("auto")),
        ToolChoice::Omit => None,
    }
}

/// The reply text of one step with tools. Only names offered on this step become calls.
pub struct StepText {
    names: HashSet<String>,
    splitter: Option<TextToolCallSplitter>,
    calls: Vec<TextToolCall>,
}

impl StepText {
    pub fn new(names: impl IntoIterator<Item = String>) -> Self {
        Self {
            names: names.into_iter().collect(),
            splitter: None,
            calls: Vec::new(),
        }
    }

    /// The plain text of `delta`; calls are kept for [`Self::end`].
    pub fn push(&mut self, delta: &str) -> Vec<String> {
        let names = &self.names;
        let splitter = self
            .splitter
            .get_or_insert_with(|| TextToolCallSplitter::new(names.iter().cloned()));
        let segments = splitter.push(delta);
        self.take(segments)
    }

    /// The text block ended (reasoning started, or the step ended): held text is released.
    pub fn end(&mut self) -> Vec<String> {
        match self.splitter.take() {
            Some(mut splitter) => {
                let segments = splitter.flush();
                self.take(segments)
            }
            None => Vec::new(),
        }
    }

    /// The calls found in the text so far, in order.
    pub fn take_calls(&mut self) -> Vec<TextToolCall> {
        std::mem::take(&mut self.calls)
    }

    fn take(&mut self, segments: Vec<Segment>) -> Vec<String> {
        let mut text = Vec::new();
        for segment in segments {
            match segment {
                Segment::Text(piece) => text.push(piece),
                Segment::Call(call) => self.calls.push(call),
            }
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_call_is_kept_and_the_text_around_it_flows() {
        let mut step = StepText::new(["vault_get_tags".to_owned()]);
        assert_eq!(step.push("Checking. <tool"), vec!["Checking. ".to_owned()]);
        assert!(
            step.push("_call>{\"name\":\"vault_get_tags\",\"arguments\":{}}")
                .is_empty()
        );
        assert!(step.end().is_empty());
        let calls = step.take_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].tool_name, "vault_get_tags");
        assert_eq!(calls[0].input, "{}");
    }

    #[test]
    fn no_offered_names_leaves_the_syntax_as_text() {
        let mut step = StepText::new(Vec::<String>::new());
        let text = "<tool_call>{\"name\":\"vault_get_tags\"}</tool_call>";
        assert_eq!(step.push(text).concat(), text);
        assert!(step.take_calls().is_empty());
    }
}
