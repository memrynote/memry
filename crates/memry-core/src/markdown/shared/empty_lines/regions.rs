//! `splitByCodeFences` of `packages/shared/src/empty-lines.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRegion {
    pub text: String,
    pub is_code: bool,
}

/// The JS line terminators: what a `^` with the `m` flag may follow.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The first position after a line terminator at or after `from`.
fn after_next_terminator(text: &str, from: usize) -> Option<usize> {
    let (at, c) = text[from..]
        .char_indices()
        .find(|(_, c)| is_line_terminator(*c))?;
    Some(from + at + c.len_utf8())
}

/// The JS pattern `^( {0,3})(```|~~~)` (flags `gm`) tried at the line start
/// `at`: the fence text and the offset just after it.
fn fence_at(text: &str, at: usize) -> Option<(&'static str, usize)> {
    let rest = &text[at..];
    let spaces = rest.bytes().take_while(|b| *b == b' ').count().min(3);
    let after = &rest[spaces..];
    let fence = if after.starts_with("```") {
        "```"
    } else if after.starts_with("~~~") {
        "~~~"
    } else {
        return None;
    };
    Some((fence, at + spaces + 3))
}

/// Splits `markdown` into code-fence and prose regions. A fence closes on any
/// line that opens with the same three characters, whatever follows them, and
/// the closing line's text stays in the code region up to its `\n`.
pub fn split_by_code_fences(markdown: &str) -> Vec<TextRegion> {
    let mut regions = Vec::new();
    let mut in_code = false;
    let mut open_fence = "";
    let mut last_index = 0;

    let mut candidate = Some(0);
    while let Some(at) = candidate {
        let mut search_from = at;
        if let Some((fence, end)) = fence_at(markdown, at) {
            search_from = end;
            if !in_code {
                if at > last_index {
                    regions.push(TextRegion {
                        text: markdown[last_index..at].to_owned(),
                        is_code: false,
                    });
                }
                in_code = true;
                open_fence = fence;
                last_index = at;
            } else if fence == open_fence {
                let fence_end = markdown[at..].find('\n').map_or(markdown.len(), |n| at + n);
                regions.push(TextRegion {
                    text: markdown[last_index..fence_end].to_owned(),
                    is_code: true,
                });
                in_code = false;
                open_fence = "";
                last_index = fence_end;
                // The closing line ends at its `\n`; a fence after a `\r`, U+2028 or U+2029
                // inside it belongs to that line (the TypeScript sets `lastIndex` the same way).
                search_from = search_from.max(fence_end);
            }
        }
        candidate = after_next_terminator(markdown, search_from);
    }

    if last_index < markdown.len() {
        regions.push(TextRegion {
            text: markdown[last_index..].to_owned(),
            is_code: in_code,
        });
    }
    regions
}
