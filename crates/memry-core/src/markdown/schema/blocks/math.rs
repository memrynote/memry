//! The math block of `blocks/markdown.ts`: a `$$` fence around the LaTeX source.

use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim};

const MATH_FENCE_LINE: &str = "$$";

/// `serializeMathBlock`: `$$` / source / `$$`, with the body's blank lines
/// dropped and each line's trailing whitespace trimmed.
pub fn serialize_math_block(latex: &str) -> String {
    let body = latex
        .split('\n')
        .map(|line| line.trim_end_matches(is_js_whitespace))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if body.is_empty() {
        format!("{MATH_FENCE_LINE}\n{MATH_FENCE_LINE}")
    } else {
        format!("{MATH_FENCE_LINE}\n{body}\n{MATH_FENCE_LINE}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MathRun {
    /// The formula source, verbatim between the fences.
    pub latex: String,
    /// The run's original lines, for the caller that declines it.
    pub raw: String,
    /// Index (in lines) of the first line after the run.
    pub end: usize,
}

/// `readMathRun`: one math run starting at `lines[start]`, or `None`. Claimed
/// only when `serialize_math_block` writes those exact bytes back, at a
/// paragraph start and with the run owning its paragraph at both ends.
pub fn read_math_run(lines: &[String], start: usize, at_paragraph_start: bool) -> Option<MathRun> {
    if !at_paragraph_start || lines.get(start)? != MATH_FENCE_LINE {
        return None;
    }
    let mut end = start + 1;
    while end < lines.len() && lines[end] != MATH_FENCE_LINE {
        end += 1;
    }
    if end >= lines.len() {
        return None;
    }
    if end + 1 < lines.len() && !js_trim(&lines[end + 1]).is_empty() {
        return None;
    }
    let raw = lines[start..=end].join("\n");
    let latex = lines[start + 1..end].join("\n");
    if serialize_math_block(&latex) != raw {
        return None;
    }
    Some(MathRun {
        latex,
        raw,
        end: end + 1,
    })
}
