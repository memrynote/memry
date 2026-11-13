//! Tool calls a server leaves in the reply text (`TextToolCallSplitter` of Electron's
//! `tool-call-profile.ts`). Hermes and Qwen chat templates write a call as
//! `<tool_call>{"name": ..., "arguments": ...}</tool_call>`; a server that cannot parse the
//! template returns it as plain text instead of `tool_calls`.

use std::collections::HashSet;

use serde_json::Value;

const OPEN_TAG: &str = "<tool_call>";
const CLOSE_TAG: &str = "</tool_call>";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextToolCall {
    pub tool_name: String,
    /// The arguments as a JSON string.
    pub input: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Text(String),
    Call(TextToolCall),
}

/// Splits streamed reply text into plain text and tool calls. Text that could be the start of an
/// open tag is held back until the next delta decides it. Only names in `tool_names` become
/// calls, so a model that quotes the syntax for some other name stays text.
pub struct TextToolCallSplitter {
    tool_names: HashSet<String>,
    pending: String,
    inside_call: bool,
}

impl TextToolCallSplitter {
    pub fn new(tool_names: impl IntoIterator<Item = String>) -> Self {
        Self {
            tool_names: tool_names.into_iter().collect(),
            pending: String::new(),
            inside_call: false,
        }
    }

    pub fn push(&mut self, delta: &str) -> Vec<Segment> {
        self.pending.push_str(delta);
        let mut segments = Vec::new();
        loop {
            if self.inside_call {
                let Some(end) = self.pending.find(CLOSE_TAG) else {
                    return segments;
                };
                let body = self.pending[..end].to_owned();
                self.pending.drain(..end + CLOSE_TAG.len());
                segments.push(self.close_call(&body));
                continue;
            }
            let Some(start) = self.pending.find(OPEN_TAG) else {
                let keep = partial_open_tag_len(&self.pending);
                let text: String = self.pending.drain(..self.pending.len() - keep).collect();
                if !text.is_empty() {
                    segments.push(Segment::Text(text));
                }
                return segments;
            };
            if start > 0 {
                segments.push(Segment::Text(self.pending[..start].to_owned()));
            }
            self.pending.drain(..start + OPEN_TAG.len());
            self.inside_call = true;
        }
    }

    /// Ends the text. A call missing only its closing tag still counts.
    pub fn flush(&mut self) -> Vec<Segment> {
        let rest = std::mem::take(&mut self.pending);
        if self.inside_call {
            return vec![self.close_call(&rest)];
        }
        if rest.is_empty() {
            Vec::new()
        } else {
            vec![Segment::Text(rest)]
        }
    }

    fn close_call(&mut self, body: &str) -> Segment {
        self.inside_call = false;
        match parse_call(body, &self.tool_names) {
            Some(call) => Segment::Call(call),
            None => Segment::Text(format!("{OPEN_TAG}{body}{CLOSE_TAG}")),
        }
    }
}

/// The length of the longest proper prefix of the open tag that `text` ends with. The tag is
/// ASCII, so the cut is always a char boundary.
fn partial_open_tag_len(text: &str) -> usize {
    (1..OPEN_TAG.len().min(text.len() + 1))
        .rev()
        .find(|&len| text.ends_with(&OPEN_TAG[..len]))
        .unwrap_or(0)
}

fn parse_call(body: &str, tool_names: &HashSet<String>) -> Option<TextToolCall> {
    let Value::Object(call) = serde_json::from_str::<Value>(body).ok()? else {
        return None;
    };
    let name = call.get("name")?.as_str()?;
    if !tool_names.contains(name) {
        return None;
    }
    let input = match call.get("arguments").or_else(|| call.get("parameters")) {
        None | Some(Value::Null) => "{}".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    };
    Some(TextToolCall {
        tool_name: name.to_owned(),
        input,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn splitter() -> TextToolCallSplitter {
        TextToolCallSplitter::new(["echo".to_owned()])
    }

    fn call(input: &str) -> Segment {
        Segment::Call(TextToolCall {
            tool_name: "echo".to_owned(),
            input: input.to_owned(),
        })
    }

    #[test]
    fn a_call_split_across_deltas_is_held_back_until_it_closes() {
        let mut s = splitter();
        assert_eq!(s.push("Sure <tool"), vec![Segment::Text("Sure ".into())]);
        assert_eq!(s.push("_call>{\"name\":\"echo\","), vec![]);
        assert_eq!(
            s.push("\"arguments\":{\"text\":\"ok\"}}</tool_call> done"),
            vec![call("{\"text\":\"ok\"}"), Segment::Text(" done".into())]
        );
        assert_eq!(s.flush(), vec![]);
    }

    #[test]
    fn an_unknown_name_or_bad_json_stays_text() {
        let mut s = splitter();
        let quoted = "<tool_call>{\"name\":\"other\"}</tool_call>";
        assert_eq!(s.push(quoted), vec![Segment::Text(quoted.into())]);
        let broken = "<tool_call>{not json</tool_call>";
        assert_eq!(s.push(broken), vec![Segment::Text(broken.into())]);
    }

    #[test]
    fn string_or_parameters_arguments_and_an_unclosed_call_at_the_end() {
        let mut s = splitter();
        assert_eq!(
            s.push("<tool_call>{\"name\":\"echo\",\"arguments\":\"{}\"}</tool_call>"),
            vec![call("{}")]
        );
        assert_eq!(
            s.push("<tool_call>{\"name\":\"echo\",\"parameters\":{\"a\":1}}"),
            vec![]
        );
        assert_eq!(s.flush(), vec![call("{\"a\":1}")]);
    }

    #[test]
    fn plain_text_ending_in_a_tag_prefix_is_released_at_flush() {
        let mut s = splitter();
        assert_eq!(s.push("a < b <tool_"), vec![Segment::Text("a < b ".into())]);
        assert_eq!(s.flush(), vec![Segment::Text("<tool_".into())]);
    }
}
