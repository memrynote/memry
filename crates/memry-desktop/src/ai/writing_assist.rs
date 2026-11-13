//! Writing assist (`ai-inline/writing-assist.ts` and `ipc/writing-tools-handlers.ts` of
//! Electron): one structured call per request that proposes alternative wordings for a
//! selection. The model only ever proposes text; nothing here touches the note.

use std::sync::Arc;

use memry_core::markdown::frontmatter::js_trim;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::proxy::{AiProxy, Owner};
use super::settings::InlineAiSettings;
use super::structured::{self, Ask, Retry, StructuredError};

/// `WRITING_ASSIST_MAX_ALTERNATIVES`.
pub const MAX_ALTERNATIVES: usize = 5;
const MAX_SELECTION_CHARS: usize = 4_000;
const MAX_CONTEXT_CHARS: usize = 8_000;

/// `WritingAssistInput` of `@memry/contracts/writing-tools-api`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WritingAssistInput {
    Alternatives { text: String, context: String },
}

/// `WritingAssistResult`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WritingAssistResult {
    Alternatives { alternatives: Vec<String> },
}

/// UTF-16 code units, as zod's `.max()` counts a string.
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

impl WritingAssistInput {
    /// `WritingAssistInputSchema`: the selection, trimmed, holds 1 to 4,000 characters and the
    /// context at most 8,000. The trimmed selection is what goes to the model.
    pub fn validate(self) -> Option<Self> {
        match self {
            Self::Alternatives { text, context } => {
                let text = js_trim(&text).to_owned();
                let valid = (1..=MAX_SELECTION_CHARS).contains(&js_length(&text))
                    && js_length(&context) <= MAX_CONTEXT_CHARS;
                valid.then_some(Self::Alternatives { text, context })
            }
        }
    }
}

#[derive(Deserialize)]
struct Alternatives {
    alternatives: Vec<String>,
}

/// `runWritingAssist`. `input` passed [`WritingAssistInput::validate`].
pub async fn run(
    proxy: &Arc<AiProxy>,
    settings: &InlineAiSettings,
    owner: &Owner,
    input: &WritingAssistInput,
    retry: Retry,
) -> Result<WritingAssistResult, StructuredError> {
    match input {
        WritingAssistInput::Alternatives { text, context } => {
            tracing::info!(
                scope = "AI:WritingAssist",
                "Writing assist request (alternatives)"
            );
            let system = format!(
                "You suggest alternative wordings for a passage the user selected in their note. Each alternative must be able to replace the selection verbatim in the surrounding sentence: same meaning, same language, same grammatical role, similar length unless shorter reads better. Return up to {MAX_ALTERNATIVES} distinct alternatives. No explanations, numbering or quotation marks."
            );
            let prompt = format!("Surrounding text:\n{context}\n\nSelection to rephrase:\n{text}");
            let ask = Ask {
                system: &system,
                prompt: &prompt,
                schema: json!({
                    "type": "object",
                    "properties": {
                        "alternatives": { "type": "array", "items": { "type": "string" } },
                    },
                    "required": ["alternatives"],
                    "additionalProperties": false,
                }),
            };
            let answer: Alternatives =
                structured::generate(proxy, settings, owner, &ask, retry).await?;
            Ok(WritingAssistResult::Alternatives {
                alternatives: clean_alternatives(&answer.alternatives, text),
            })
        }
    }
}

/// `cleanAlternatives`: trimmed, outer quotes dropped, no repeat and not the original, at most
/// [`MAX_ALTERNATIVES`].
pub fn clean_alternatives(candidates: &[String], original: &str) -> Vec<String> {
    const OPENING: &[char] = &['"', '\u{201C}', '\'', '\u{2018}'];
    const CLOSING: &[char] = &['"', '\u{201D}', '\'', '\u{2019}'];
    let mut seen = vec![js_trim(original).to_owned()];
    let mut result = Vec::new();
    for candidate in candidates {
        let text = js_trim(candidate)
            .trim_start_matches(OPENING)
            .trim_end_matches(CLOSING);
        let text = js_trim(text);
        if text.is_empty() || seen.iter().any(|known| known == text) {
            continue;
        }
        seen.push(text.to_owned());
        result.push(text.to_owned());
        if result.len() == MAX_ALTERNATIVES {
            break;
        }
    }
    result
}
