//! Port of `packages/editor-schema/src/inline/token-masking.ts`: memry's
//! `((mention:…))` and `((date:…))` inline tokens, hidden from the markdown
//! parser as inert placeholders and put back once the blocks exist.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::Serialize;

use crate::markdown::shared::markdown_fences::FenceTracker;

/// `\(\((?:mention|date):[^()\n\r]*\)\)`: both payloads stop at a literal paren.
static INLINE_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(\((?:mention|date):[^()\n\r]*\)\)").expect("static pattern"));

/// A backslash escape the markdown parser would have consumed: a backslash
/// before ASCII punctuation.
static STRAY_ESCAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\([!-/:-@\[-`{-~])").expect("static pattern"));

static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"MEMRYTKN([0-9]+)X").expect("static pattern"));

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MaskedInlineTokens {
    pub markdown: String,
    /// The masked tokens, by placeholder index. Empty when nothing was masked.
    pub tokens: Vec<String>,
}

/// Replace every `((mention:…))` / `((date:…))` outside a code fence with an
/// inert placeholder. A token inside a fence is the author writing about the syntax.
pub fn mask_inline_tokens(markdown: &str) -> MaskedInlineTokens {
    let unchanged = || MaskedInlineTokens {
        markdown: markdown.to_owned(),
        tokens: Vec::new(),
    };
    if !markdown.contains("((") {
        return unchanged();
    }

    let mut tokens: Vec<String> = Vec::new();
    let mut fence = FenceTracker::new();
    let masked: Vec<String> = markdown
        .split('\n')
        .map(|line| {
            if fence.consume(line) {
                return line.to_owned();
            }
            INLINE_TOKEN
                .replace_all(line, |caps: &Captures| {
                    tokens.push(STRAY_ESCAPE.replace_all(&caps[0], "$1").into_owned());
                    format!("MEMRYTKN{}X", tokens.len() - 1)
                })
                .into_owned()
        })
        .collect();

    if tokens.is_empty() {
        return unchanged();
    }
    MaskedInlineTokens {
        markdown: masked.join("\n"),
        tokens,
    }
}

/// Put back the tokens [`mask_inline_tokens`] hid, for one inline text run. A
/// placeholder with no matching token is the author's own bytes and stays.
pub fn restore_inline_tokens(text: &str, tokens: &[String]) -> String {
    if tokens.is_empty() || !text.contains("MEMRYTKN") {
        return text.to_owned();
    }
    PLACEHOLDER
        .replace_all(text, |caps: &Captures| {
            caps[1]
                .parse::<usize>()
                .ok()
                .and_then(|index| tokens.get(index))
                .cloned()
                .unwrap_or_else(|| caps[0].to_owned())
        })
        .into_owned()
}
