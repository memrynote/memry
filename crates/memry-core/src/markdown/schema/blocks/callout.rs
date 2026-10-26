//! The callout block of `blocks/markdown.ts`: `> [!type]` followed by the
//! content, one `> ` per line.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ParseMarkdown, ParsedBlock, SerializeBlocks};
use crate::markdown::frontmatter::js::js_trim;
use crate::markdown::schema::callout_types::CalloutTypes;
use crate::markdown::schema::quote::{
    content_or_empty, item_holds_non_list, read_structured_quote_run, serialize_quote_block,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalloutFold {
    None,
    Closed,
    Open,
}

impl CalloutFold {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Closed => "closed",
            Self::Open => "open",
        }
    }

    fn from_suffix(suffix: &str) -> Self {
        match suffix {
            "-" => Self::Closed,
            "+" => Self::Open,
            _ => Self::None,
        }
    }
}

/// `calloutMarker`: the `[!type]` plus fold suffix. A fold other than `none`,
/// `closed` or `open`, or none at all, writes no suffix.
pub fn callout_marker(callout_type: &str, fold: Option<&str>) -> String {
    let suffix = match fold {
        Some("closed") => "-",
        Some("open") => "+",
        _ => "",
    };
    format!("[!{callout_type}]{suffix}")
}

/// `serializeCalloutBlock`: `contentMarkdown` is the callout's own line followed
/// by its child blocks; each blank line becomes a bare `>`.
pub fn serialize_callout_block(
    callout_type: &str,
    content_markdown: &str,
    fold: Option<&str>,
) -> String {
    let body = content_markdown.trim_matches('\n');
    let marker = format!("> {}", callout_marker(callout_type, fold));
    if body.is_empty() {
        return marker;
    }
    format!("{marker}\n{}", serialize_quote_block(body))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalloutRun {
    #[serde(rename = "type")]
    pub callout_type: String,
    pub fold: CalloutFold,
    /// Body lines with the `> ` prefix stripped; verbatim for a bare run.
    pub content_lines: Vec<String>,
    /// The run's original lines, verbatim, for fallback parsing on decline.
    pub raw: String,
    /// Index (in lines) of the first line after the run.
    pub end: usize,
    /// The damaged shape #1846 heals: marker without its `> `.
    pub bare: bool,
    /// The body holds a list or a `> >` level.
    pub reshapes: bool,
}

/// `^> \[!([a-z][a-z0-9_-]*)\]([-+]?)$` with the type known to `types`.
fn match_callout_marker<'a>(line: &'a str, types: &CalloutTypes) -> Option<(&'a str, &'a str)> {
    let inner = line.strip_prefix("> [!")?;
    let close = inner.find(']')?;
    let (name, after) = (&inner[..close], &inner[close + 1..]);
    let mut chars = name.chars();
    if !matches!(chars.next(), Some('a'..='z'))
        || !chars.all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_' | '-'))
    {
        return None;
    }
    if !matches!(after, "" | "-" | "+") {
        return None;
    }
    types.is_callout_type_name(name).then_some((name, after))
}

/// `^\[!(info|warning|error|success)\]$`
fn match_bare_callout_marker(line: &str) -> Option<&str> {
    let name = line.strip_prefix("[!")?.strip_suffix(']')?;
    matches!(name, "info" | "warning" | "error" | "success").then_some(name)
}

/// `/^> (.+)$/`: `.` stops at a line terminator.
fn quoted_body_line(line: &str) -> Option<&str> {
    let body = line.strip_prefix("> ")?;
    let valid = !body.is_empty() && !body.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    valid.then_some(body)
}

/// `readCalloutRun`: one callout run starting at `lines[start]`, or `None`.
/// Accepts the exact bytes `serializeCalloutBlock` writes and the bare damaged
/// shape, both only at a paragraph start. A start past the end of `lines`
/// reads nothing (the TypeScript throws).
pub fn read_callout_run(
    lines: &[String],
    start: usize,
    at_paragraph_start: bool,
    types: &CalloutTypes,
) -> Option<CalloutRun> {
    if !at_paragraph_start {
        return None;
    }
    let line = lines.get(start)?;

    if let Some((name, suffix)) = match_callout_marker(line, types) {
        if let Some(structured) = read_structured_quote_run(lines, start + 1) {
            return Some(CalloutRun {
                callout_type: name.to_owned(),
                fold: CalloutFold::from_suffix(suffix),
                content_lines: structured
                    .inner_markdown
                    .split('\n')
                    .map(str::to_owned)
                    .collect(),
                raw: lines[start..structured.end].join("\n"),
                end: structured.end,
                bare: false,
                reshapes: structured.listed || structured.nested,
            });
        }
        let mut content_lines = Vec::new();
        let mut end = start + 1;
        while end < lines.len() {
            let Some(body) = quoted_body_line(&lines[end]) else {
                break;
            };
            content_lines.push(body.to_owned());
            end += 1;
        }
        if end < lines.len() && lines[end].starts_with('>') {
            return None;
        }
        return Some(CalloutRun {
            callout_type: name.to_owned(),
            fold: CalloutFold::from_suffix(suffix),
            content_lines,
            raw: lines[start..end].join("\n"),
            end,
            bare: false,
            reshapes: false,
        });
    }

    let name = match_bare_callout_marker(line)?;
    let mut content_lines = Vec::new();
    let mut end = start + 1;
    while end < lines.len() && !js_trim(&lines[end]).is_empty() {
        content_lines.push(lines[end].clone());
        end += 1;
    }
    if content_lines.is_empty() {
        return None;
    }
    Some(CalloutRun {
        callout_type: name.to_owned(),
        fold: CalloutFold::None,
        content_lines,
        raw: lines[start..end].join("\n"),
        end,
        bare: true,
        reshapes: false,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResolvedCallout {
    #[serde(rename = "type")]
    pub callout_type: String,
    pub fold: CalloutFold,
    pub content: Value,
    pub children: Vec<ParsedBlock>,
}

struct CalloutBody {
    content: Value,
    children: Vec<ParsedBlock>,
    markdown: String,
}

/// `resolveCalloutRun`: whether a run may become a callout block, by proof:
/// parse the body and claim only if serializing it back reproduces it (or, for
/// a body with a list or a `> >` level, a canonical form that settles).
pub fn resolve_callout_run(
    run: &CalloutRun,
    types: &CalloutTypes,
    parse_markdown: ParseMarkdown,
    serialize_blocks: SerializeBlocks,
) -> Result<Option<ResolvedCallout>, String> {
    let content = run.content_lines.join("\n");
    let resolved = |content: Value, children: Vec<ParsedBlock>| ResolvedCallout {
        callout_type: run.callout_type.clone(),
        fold: run.fold,
        content,
        children,
    };
    if content.is_empty() {
        return Ok(Some(resolved(Value::Array(Vec::new()), Vec::new())));
    }

    let Some(body) = parse_callout_body(&content, parse_markdown, serialize_blocks)? else {
        return Ok(None);
    };
    if run.bare && !body.children.is_empty() {
        return Ok(None);
    }
    if body.markdown != content {
        if !run.reshapes {
            return Ok(None);
        }
        let canonical =
            serialize_callout_block(&run.callout_type, &body.markdown, Some(run.fold.as_str()));
        if !callout_settles(&canonical, types, parse_markdown, serialize_blocks)? {
            return Ok(None);
        }
    }
    Ok(Some(resolved(body.content, body.children)))
}

fn parse_callout_body(
    content: &str,
    parse_markdown: ParseMarkdown,
    serialize_blocks: SerializeBlocks,
) -> Result<Option<CalloutBody>, String> {
    let parsed = parse_markdown(content)?;
    let Some((first, rest)) = parsed.split_first() else {
        return Ok(None);
    };
    if parsed.iter().any(item_holds_non_list) {
        return Ok(None);
    }
    let own_line = first.get("type").and_then(Value::as_str) == Some("paragraph");
    let has_children = first
        .get("children")
        .and_then(Value::as_array)
        .is_some_and(|children| !children.is_empty());
    if own_line && has_children {
        return Ok(None);
    }
    let markdown = js_trim(&serialize_blocks(&parsed)?).to_owned();
    Ok(Some(CalloutBody {
        content: if own_line {
            content_or_empty(first)
        } else {
            Value::Array(Vec::new())
        },
        children: if own_line { rest.to_vec() } else { parsed },
        markdown,
    }))
}

/// Whether `canonical` is a fixed point: it reads back as one whole callout
/// run, and re-parsing its body reproduces it.
fn callout_settles(
    canonical: &str,
    types: &CalloutTypes,
    parse_markdown: ParseMarkdown,
    serialize_blocks: SerializeBlocks,
) -> Result<bool, String> {
    let lines: Vec<String> = canonical.split('\n').map(str::to_owned).collect();
    let Some(reread) = read_callout_run(&lines, 0, true, types) else {
        return Ok(false);
    };
    if reread.end != lines.len() {
        return Ok(false);
    }
    let content = reread.content_lines.join("\n");
    let body = parse_callout_body(&content, parse_markdown, serialize_blocks)?;
    Ok(body.is_some_and(|body| body.markdown == content))
}
