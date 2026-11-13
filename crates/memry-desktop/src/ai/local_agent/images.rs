//! The turn's messages, with tool images placed as `tool-images.ts` places them. Chat
//! Completions tool messages carry text only, so each tool image moves into a user message right
//! after the run of tool messages, or, for a model that does not take images, becomes
//! [`TOOL_IMAGE_NOT_SENT`]. Whether the model takes images is asked only when a tool returned one.

use serde_json::Value;

use super::ToolImage;

/// Said in place of a tool image to a model that does not take images (FB-002 Decision 3).
pub const TOOL_IMAGE_NOT_SENT: &str = "The image was not sent: this model does not take images. vault_read_note returns the text read from the file.";

/// One step of the turn after the prompt, as the next request replays it.
#[derive(Debug, Clone)]
pub(super) enum Entry {
    Assistant(Assistant),
    Tool(ToolEntry),
}

#[derive(Debug, Clone, Default)]
pub(super) struct Assistant {
    pub text: String,
    /// Sent back as `reasoning_content` (Ollama: `thinking`): thinking-mode providers such as
    /// DeepSeek reject a tool loop that drops it (#2609).
    pub reasoning: String,
    pub calls: Vec<CallRecord>,
}

#[derive(Debug, Clone)]
pub(super) struct CallRecord {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone)]
pub(super) struct ToolEntry {
    pub call_id: String,
    pub tool_name: String,
    pub output: ToolOutput,
}

/// The AI SDK's tool output kinds the engine produces.
#[derive(Debug, Clone)]
pub(super) enum ToolOutput {
    /// `json`: the content is the compact JSON text.
    Json(Value),
    /// `error-text`: a call that never reached the host (unknown tool, unreadable arguments).
    ErrorText(String),
    /// `content`: the result as JSON text, then its images.
    WithImages {
        text: String,
        images: Vec<ToolImage>,
    },
}

/// A message ready for a wire format.
#[derive(Debug)]
pub(super) enum Msg<'a> {
    System(&'a str),
    User(&'a str),
    /// The images of the tool messages before it, each after a caption.
    UserParts(Vec<UserPart>),
    Assistant(&'a Assistant),
    Tool {
        call_id: &'a str,
        content: String,
    },
}

#[derive(Debug)]
pub(super) enum UserPart {
    Text(String),
    Image(ToolImage),
}

pub(super) fn has_tool_images(history: &[Entry]) -> bool {
    history.iter().any(|entry| {
        matches!(entry, Entry::Tool(ToolEntry { output: ToolOutput::WithImages { images, .. }, .. }) if !images.is_empty())
    })
}

/// The request messages: the system line, the prompt, then the turn so far. `accepts_images`
/// is read only when the history holds a tool image.
pub(super) fn messages<'a>(
    system: Option<&'a str>,
    prompt: &'a str,
    history: &'a [Entry],
    accepts_images: bool,
) -> Vec<Msg<'a>> {
    let mut out = Vec::with_capacity(history.len() + 3);
    out.extend(system.map(Msg::System));
    out.push(Msg::User(prompt));
    let mut shown = Vec::new();
    for entry in history {
        let tool = match entry {
            Entry::Assistant(assistant) => {
                if !shown.is_empty() {
                    out.push(Msg::UserParts(std::mem::take(&mut shown)));
                }
                out.push(Msg::Assistant(assistant));
                continue;
            }
            Entry::Tool(tool) => tool,
        };
        let content = match &tool.output {
            ToolOutput::Json(value) => value.to_string(),
            ToolOutput::ErrorText(text) => text.clone(),
            ToolOutput::WithImages { text, images } if images.is_empty() => text.clone(),
            ToolOutput::WithImages { text, .. } if !accepts_images => {
                format!("{text}\n{TOOL_IMAGE_NOT_SENT}")
            }
            ToolOutput::WithImages { text, images } => {
                shown.push(UserPart::Text(format!(
                    "Image returned by {} (call {}):",
                    tool.tool_name, tool.call_id
                )));
                shown.extend(images.iter().cloned().map(UserPart::Image));
                text.clone()
            }
        };
        out.push(Msg::Tool {
            call_id: &tool.call_id,
            content,
        });
    }
    if !shown.is_empty() {
        out.push(Msg::UserParts(shown));
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn image() -> ToolImage {
        ToolImage {
            data: "AAAA".into(),
            mime_type: "image/png".into(),
        }
    }

    fn history() -> Vec<Entry> {
        vec![
            Entry::Assistant(Assistant::default()),
            Entry::Tool(ToolEntry {
                call_id: "c1".into(),
                tool_name: "vault_view_file".into(),
                output: ToolOutput::WithImages {
                    text: "{\"ok\":true}".into(),
                    images: vec![image()],
                },
            }),
            Entry::Tool(ToolEntry {
                call_id: "c2".into(),
                tool_name: "vault_get_tags".into(),
                output: ToolOutput::Json(json!({ "ok": true })),
            }),
            Entry::Assistant(Assistant::default()),
        ]
    }

    #[test]
    fn an_image_moves_after_the_run_of_tool_messages() {
        let history = history();
        assert!(has_tool_images(&history));
        let messages = messages(None, "hi", &history, true);
        let kinds: Vec<&str> = messages
            .iter()
            .map(|message| match message {
                Msg::System(_) => "system",
                Msg::User(_) => "user",
                Msg::UserParts(_) => "images",
                Msg::Assistant(_) => "assistant",
                Msg::Tool { .. } => "tool",
            })
            .collect();
        assert_eq!(
            kinds,
            ["user", "assistant", "tool", "tool", "images", "assistant"]
        );
        let Msg::UserParts(parts) = &messages[4] else {
            unreachable!()
        };
        assert!(
            matches!(&parts[0], UserPart::Text(text) if text == "Image returned by vault_view_file (call c1):")
        );
        assert!(matches!(&parts[1], UserPart::Image(_)));
    }

    #[test]
    fn a_model_without_images_gets_the_notice_and_no_image() {
        let history = history();
        let messages = messages(Some("sys"), "hi", &history, false);
        assert!(
            !messages
                .iter()
                .any(|message| matches!(message, Msg::UserParts(_)))
        );
        let Msg::Tool { content, .. } = &messages[3] else {
            unreachable!()
        };
        assert_eq!(content, &format!("{{\"ok\":true}}\n{TOOL_IMAGE_NOT_SENT}"));
    }
}
