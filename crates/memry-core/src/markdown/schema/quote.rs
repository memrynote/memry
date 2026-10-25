//! Port of `packages/editor-schema/src/blocks/quote.ts`: a blockquote run whose
//! inner structure BlockNote's flat `quote` block cannot hold on its own.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim};
use crate::markdown::schema::blocks::{ParseMarkdown, ParsedBlock, SerializeBlocks};
use crate::markdown::shared::markdown_fences::FenceTracker;

/// `serializeQuoteBlock`: one `> ` per line, a bare `>` per blank line.
pub fn serialize_quote_block(inner_markdown: &str) -> String {
    inner_markdown
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                ">".to_owned()
            } else {
                format!("> {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRun {
    /// The run's lines with one `>` level stripped.
    pub inner_markdown: String,
    /// The run's original lines, verbatim, for fallback parsing on decline.
    pub raw: String,
    /// Index (in lines) of the first line after the run.
    pub end: usize,
    /// The run carries a second `>` level.
    pub nested: bool,
    /// The run holds a list.
    pub listed: bool,
}

fn is_blank(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// Leading spaces, at most 3: `^ {0,3}`. `None` when there are more (the
/// pattern needs a non-space next, so a fourth space can never match).
fn indent3(line: &str) -> Option<&str> {
    let spaces = line.bytes().take_while(|b| *b == b' ').count();
    (spaces <= 3).then(|| &line[spaces..])
}

/// `^ {0,3}([-*+]|1[.)])[ \t]+\S`
fn is_interrupting_item(line: &str) -> bool {
    let Some(rest) = indent3(line) else {
        return false;
    };
    let rest = match rest.as_bytes() {
        [b'-' | b'*' | b'+', ..] => &rest[1..],
        [b'1', b'.' | b')', ..] => &rest[2..],
        _ => return false,
    };
    let after = rest.trim_start_matches(is_blank);
    after.len() < rest.len() && after.chars().next().is_some_and(|c| !is_js_whitespace(c))
}

/// `^ {0,3}([-*+]|\d{1,9}[.)])([ \t]|$)`
fn is_list_item(line: &str) -> bool {
    let Some(rest) = indent3(line) else {
        return false;
    };
    let after = match rest.as_bytes() {
        [b'-' | b'*' | b'+', ..] => &rest[1..],
        _ => {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            if !(1..=9).contains(&digits)
                || !matches!(rest.as_bytes().get(digits), Some(b'.' | b')'))
            {
                return false;
            }
            &rest[digits + 1..]
        }
    };
    after.is_empty() || after.starts_with(is_blank)
}

/// `BLOCK_START`: a line that starts a block of its own.
fn is_block_start(line: &str) -> bool {
    let Some(rest) = indent3(line) else {
        return false;
    };
    if rest.starts_with(['>', '<', '|']) || rest.starts_with("```") || rest.starts_with("~~~") {
        return true;
    }
    if rest.starts_with('#') {
        let hashes = rest.bytes().take_while(|b| *b == b'#').count();
        let after = &rest[hashes..];
        if hashes <= 6 && (after.is_empty() || after.starts_with(is_blank)) {
            return true;
        }
    }
    let body = rest.trim_end_matches(is_blank);
    // `[-*_=]+[ \t]*$`
    if !body.is_empty() && body.chars().all(|c| matches!(c, '-' | '*' | '_' | '=')) {
        return true;
    }
    // `[-*_]([ \t]*[-*_]){2,}[ \t]*$`
    body.starts_with(['-', '*', '_'])
        && body
            .chars()
            .all(|c| matches!(c, '-' | '*' | '_') || is_blank(c))
        && body.chars().filter(|c| !is_blank(*c)).count() >= 3
}

/// `^ {0,3}(```|~~~)`
fn is_fence_start(line: &str) -> bool {
    indent3(line).is_some_and(|rest| rest.starts_with("```") || rest.starts_with("~~~"))
}

/// `readStructuredQuoteRun`: a blockquote run at `lines[start]` whose inner
/// structure BlockNote cannot hold flat (a blank `>` separator, a `> >` level
/// or a list), or `None`. A `>text` line refuses the whole run.
pub fn read_structured_quote_run(lines: &[String], start: usize) -> Option<QuoteRun> {
    if !lines.get(start)?.starts_with('>') {
        return None;
    }
    let mut inner: Vec<String> = Vec::new();
    let mut end = start;
    let mut separated = false;
    let mut nested = false;
    let mut listed = false;
    let mut fence = FenceTracker::new();

    while end < lines.len() && lines[end].starts_with('>') {
        let line = &lines[end];
        if line == ">" {
            inner.push(String::new());
            separated = true;
        } else {
            let stripped = line.strip_prefix("> ")?;
            inner.push(stripped.to_owned());
            if stripped.starts_with('>') {
                nested = true;
            }
            let opens_item = inner.len() == 1 || inner[inner.len() - 2].is_empty();
            let is_item = is_interrupting_item(stripped) || (opens_item && is_list_item(stripped));
            if !fence.consume(stripped) && is_item {
                listed = true;
            }
        }
        end += 1;
    }

    // A line after a listed run that neither opens a block nor follows a gap
    // continues the item's paragraph lazily.
    if listed
        && inner.last().is_some_and(|line| !line.is_empty())
        && !inner.iter().any(|line| is_fence_start(line))
    {
        while end < lines.len()
            && !js_trim(&lines[end]).is_empty()
            && !is_list_item(&lines[end])
            && !is_block_start(&lines[end])
        {
            inner.push(lines[end].clone());
            end += 1;
        }
    }

    if !separated && !nested && !listed {
        return None;
    }
    Some(QuoteRun {
        inner_markdown: inner.join("\n"),
        raw: lines[start..end].join("\n"),
        end,
        nested,
        listed,
    })
}

fn is_list_block(block: &Value) -> bool {
    matches!(
        block.get("type").and_then(Value::as_str),
        Some("bulletListItem" | "numberedListItem" | "checkListItem")
    )
}

fn child_blocks(block: &Value) -> &[Value] {
    block
        .get("children")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `itemHoldsNonList`: a list item that owns a block other than a list item.
pub fn item_holds_non_list(block: &ParsedBlock) -> bool {
    if !is_list_block(block) {
        return false;
    }
    child_blocks(block)
        .iter()
        .any(|child| !is_list_block(child) || item_holds_non_list(child))
}

/// A quote's own content and the blocks it owns.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClaimedQuote {
    pub content: Value,
    pub children: Vec<ParsedBlock>,
}

/// `block.content ?? []`.
pub(crate) fn content_or_empty(block: &Value) -> Value {
    match block.get("content") {
        None | Some(Value::Null) => json!([]),
        Some(content) => content.clone(),
    }
}

fn split_quote_blocks(parsed: &[ParsedBlock]) -> Option<ClaimedQuote> {
    let (first, rest) = parsed.split_first()?;
    if is_list_block(first) {
        return Some(ClaimedQuote {
            content: json!([]),
            children: parsed.to_vec(),
        });
    }
    if !child_blocks(first).is_empty() {
        return None;
    }
    let kind = first.get("type").and_then(Value::as_str);
    if kind == Some("quote") {
        return Some(ClaimedQuote {
            content: json!([]),
            children: parsed.to_vec(),
        });
    }
    if kind != Some("paragraph") || rest.is_empty() {
        return None;
    }
    Some(ClaimedQuote {
        content: content_or_empty(first),
        children: rest.to_vec(),
    })
}

/// `resolveQuoteRun`: whether a run may become a quote block that owns
/// children, by proof: the parsed and re-serialized inner markdown must give
/// the run back, or (for a nested or listed run) a canonical form that settles.
pub fn resolve_quote_run(
    run: &QuoteRun,
    parse_markdown: ParseMarkdown,
    serialize_blocks: SerializeBlocks,
) -> Result<Option<ClaimedQuote>, String> {
    let parsed = parse_markdown(&run.inner_markdown)?;
    let Some(claimed) = split_quote_blocks(&parsed) else {
        return Ok(None);
    };
    if run.listed && parsed.iter().any(item_holds_non_list) {
        return Ok(None);
    }
    let canonical = serialize_quote_block(js_trim(&serialize_blocks(&parsed)?));
    if canonical != run.raw {
        if !run.nested && !run.listed {
            return Ok(None);
        }
        if !settles(&canonical, parse_markdown, serialize_blocks)? {
            return Ok(None);
        }
    }
    Ok(Some(claimed))
}

/// Whether `canonical` is a fixed point: it reads back as one whole quote run,
/// and re-parsing and re-quoting that run returns it unchanged.
fn settles(
    canonical: &str,
    parse_markdown: ParseMarkdown,
    serialize_blocks: SerializeBlocks,
) -> Result<bool, String> {
    let lines: Vec<String> = canonical.split('\n').map(str::to_owned).collect();
    let Some(reread) = read_structured_quote_run(&lines, 0) else {
        return Ok(false);
    };
    if reread.end != lines.len() {
        return Ok(false);
    }
    let reparsed = parse_markdown(&reread.inner_markdown)?;
    if split_quote_blocks(&reparsed).is_none() {
        return Ok(false);
    }
    Ok(serialize_quote_block(js_trim(&serialize_blocks(&reparsed)?)) == canonical)
}
