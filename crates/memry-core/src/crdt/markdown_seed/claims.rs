//! The multi-line runs `parseContentWithMarkers` claims before BlockNote's
//! parser sees them: a callout (`editor-schema/src/blocks/markdown.ts`
//! `readCalloutRun`, `resolveCalloutRun`), a `$$` math block (`readMathRun`)
//! and a structured quote (`blocks/quote.ts` `readStructuredQuoteRun`,
//! `resolveQuoteRun`).
//!
//! Desktop claims a callout or a quote only when serializing the parsed body
//! reproduces it byte for byte. [`super::roundtrip`] serializes the bodies it
//! can serialize exactly; any other body is [`Unsupported`], never guessed.

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::blocks::parse_chunk;
use super::roundtrip::serialize;
use super::{SeedBlock, SeedKind, Unsupported};

/// A claimed run: its block and the index of the first line after it.
pub(super) type Claim = (SeedBlock, usize);

/// The built-in `CALLOUT_TYPE_VALUES`. A user-defined type is a callout on
/// desktop too, but the core cannot see those definitions here.
const CALLOUT_TYPES: [&str; 13] = [
    "info",
    "warning",
    "error",
    "success",
    "note",
    "abstract",
    "todo",
    "tip",
    "important",
    "question",
    "example",
    "quote",
    "bug",
];

/// `CALLOUT_MARKER_REGEX`, `/^> \[!([a-z][a-z0-9_-]*)\]([-+]?)$/`: the type
/// and the fold.
fn callout_marker(line: &str) -> Option<(&str, &'static str)> {
    let inner = line.strip_prefix("> [!")?;
    let (name, suffix) = inner.split_once(']')?;
    let fold = match suffix {
        "" => "none",
        "-" => "closed",
        "+" => "open",
        _ => return None,
    };
    let valid = name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'));
    valid.then_some((name, fold))
}

/// `parseCalloutRunAt`.
pub(super) fn callout_at(
    lines: &[&str],
    start: usize,
    at_paragraph_start: bool,
) -> Result<Option<Claim>, Unsupported> {
    if !at_paragraph_start {
        return Ok(None);
    }
    if let Some((name, fold)) = callout_marker(lines[start]) {
        if !CALLOUT_TYPES.contains(&name) {
            return if name.len() <= 32 {
                Err(Unsupported("custom callout type"))
            } else {
                Ok(None)
            };
        }
        if let Some(run) = structured_quote_run(lines, start + 1) {
            if run.reshapes {
                return Err(Unsupported("callout holding a list or a nested quote"));
            }
            return resolve_callout(name, fold, &run.inner.join("\n"), false)
                .map(|claim| claim.map(|block| (block, run.end)));
        }
        let mut end = start + 1;
        let mut content = Vec::new();
        while let Some(body) = lines.get(end).and_then(|line| line.strip_prefix("> ")) {
            if body.is_empty() {
                break;
            }
            content.push(body);
            end += 1;
        }
        if lines.get(end).is_some_and(|line| line.starts_with('>')) {
            return Ok(None);
        }
        return resolve_callout(name, fold, &content.join("\n"), false)
            .map(|claim| claim.map(|block| (block, end)));
    }
    let bare = lines[start]
        .strip_prefix("[!")
        .and_then(|rest| rest.strip_suffix(']'))
        .filter(|name| matches!(*name, "info" | "warning" | "error" | "success"));
    let Some(name) = bare else {
        return Ok(None);
    };
    let mut end = start + 1;
    while lines.get(end).is_some_and(|line| !js_trim(line).is_empty()) {
        end += 1;
    }
    if end == start + 1 {
        return Ok(None);
    }
    resolve_callout(name, "none", &lines[start + 1..end].join("\n"), true)
        .map(|claim| claim.map(|block| (block, end)))
}

/// `resolveCalloutRun` for a run without a structured body (`reshapes` is
/// false): the body's first paragraph is the callout's own line, the blocks
/// after it its children.
fn resolve_callout(
    name: &str,
    fold: &str,
    content: &str,
    bare: bool,
) -> Result<Option<SeedBlock>, Unsupported> {
    let kind = SeedKind::Callout {
        kind: name.to_owned(),
        fold: fold.to_owned(),
    };
    if content.is_empty() {
        return Ok(Some(SeedBlock::new(kind, Vec::new())));
    }
    let parsed = parse_body(content)?;
    let Some(first) = parsed.first() else {
        return Ok(None);
    };
    if parsed.iter().any(item_holds_non_list) {
        return Ok(None);
    }
    let own_line = first.kind == SeedKind::Paragraph;
    if own_line && !first.children.is_empty() {
        return Ok(None);
    }
    let children: Vec<SeedBlock> = if own_line {
        parsed[1..].to_vec()
    } else {
        parsed.clone()
    };
    if bare && !children.is_empty() {
        return Ok(None);
    }
    if js_trim(&serialize(&parsed)?) != content {
        return Ok(None);
    }
    let own = if own_line {
        first.content.clone()
    } else {
        Vec::new()
    };
    Ok(Some(SeedBlock {
        kind,
        content: own,
        children,
    }))
}

/// `readMathRun`: `$$`, the formula, `$$`, owning its whole paragraph and in
/// the exact bytes `serializeMathBlock` writes.
pub(super) fn math_at(lines: &[&str], start: usize, at_paragraph_start: bool) -> Option<Claim> {
    if !at_paragraph_start || lines[start] != "$$" {
        return None;
    }
    let close = start + 1 + lines[start + 1..].iter().position(|line| *line == "$$")?;
    if lines
        .get(close + 1)
        .is_some_and(|line| !js_trim(line).is_empty())
    {
        return None;
    }
    let body = &lines[start + 1..close];
    let canonical = body
        .iter()
        .all(|line| !line.is_empty() && !line.ends_with(is_js_whitespace));
    if !canonical {
        return None;
    }
    let block = SeedBlock::new(
        SeedKind::Math {
            latex: body.join("\n"),
        },
        Vec::new(),
    );
    Some((block, close + 1))
}

/// A `readStructuredQuoteRun` result: the run's lines with one `>` level
/// stripped, where it ends, and whether it holds a `> >` level or a list.
struct QuoteRun {
    inner: Vec<String>,
    end: usize,
    reshapes: bool,
}

/// `parseQuoteRunAt`: a quote with a blank `>` line between its paragraphs
/// becomes a quote block owning the later blocks as children. A quote with a
/// `> >` level or a list is [`Unsupported`]: desktop claims those by
/// re-reading its canonical form, which this port does not serialize.
pub(super) fn quote_at(lines: &[&str], start: usize) -> Result<Option<Claim>, Unsupported> {
    let Some(run) = structured_quote_run(lines, start) else {
        return Ok(None);
    };
    if run.reshapes {
        return Err(Unsupported("quote holding a list or a nested quote"));
    }
    let parsed = parse_body(&run.inner.join("\n"))?;
    let Some(first) = parsed.first() else {
        return Ok(None);
    };
    let is_list = |block: &SeedBlock| {
        matches!(
            block.kind,
            SeedKind::BulletListItem
                | SeedKind::NumberedListItem { .. }
                | SeedKind::CheckListItem { .. }
        )
    };
    let (content, children) = if is_list(first) || first.kind == SeedKind::Quote {
        if is_list(first) || first.children.is_empty() {
            (Vec::new(), parsed.clone())
        } else {
            return Ok(None);
        }
    } else if first.kind == SeedKind::Paragraph && first.children.is_empty() && parsed.len() > 1 {
        (first.content.clone(), parsed[1..].to_vec())
    } else {
        return Ok(None);
    };
    let canonical: Vec<String> = js_trim(&serialize(&parsed)?)
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                ">".to_owned()
            } else {
                format!("> {line}")
            }
        })
        .collect();
    if canonical.join("\n") != lines[start..run.end].join("\n") {
        return Ok(None);
    }
    Ok(Some((
        SeedBlock {
            kind: SeedKind::Quote,
            content,
            children,
        },
        run.end,
    )))
}

/// `readStructuredQuoteRun` up to its verdict: `Some` for a run of `>` lines
/// holding a blank `>` line, a `> >` level or a list item.
fn structured_quote_run(lines: &[&str], start: usize) -> Option<QuoteRun> {
    if !lines.get(start)?.starts_with('>') {
        return None;
    }
    let mut inner: Vec<String> = Vec::new();
    let mut end = start;
    let (mut separated, mut reshapes) = (false, false);
    while let Some(line) = lines.get(end).filter(|line| line.starts_with('>')) {
        if *line == ">" {
            inner.push(String::new());
            separated = true;
        } else {
            let stripped = line.strip_prefix("> ")?;
            inner.push(stripped.to_owned());
            // A `> >` level or a list item (which the source also tracks
            // fences for); both are refused, so a superset is enough here.
            reshapes |= stripped.starts_with('>') || looks_like_list_item(stripped);
        }
        end += 1;
    }
    (separated || reshapes).then_some(QuoteRun {
        inner,
        end,
        reshapes,
    })
}

/// A superset of `INTERRUPTING_ITEM` and `LIST_ITEM`.
fn looks_like_list_item(line: &str) -> bool {
    let rest = line.trim_start_matches(' ');
    if line.len() - rest.len() > 3 {
        return false;
    }
    let after = match rest.strip_prefix(['-', '*', '+']) {
        Some(after) => after,
        None => {
            let digits = rest.chars().take_while(char::is_ascii_digit).count();
            match rest[digits..].strip_prefix(['.', ')']) {
                Some(after) if digits > 0 => after,
                _ => return false,
            }
        }
    };
    after.is_empty() || after.starts_with([' ', '\t'])
}

/// `itemHoldsNonList`.
fn item_holds_non_list(block: &SeedBlock) -> bool {
    let list = |block: &SeedBlock| {
        matches!(
            block.kind,
            SeedKind::BulletListItem
                | SeedKind::NumberedListItem { .. }
                | SeedKind::CheckListItem { .. }
        )
    };
    list(block)
        && block
            .children
            .iter()
            .any(|child| !list(child) || item_holds_non_list(child))
}

/// A body as `parseMarkdownToBlocks` reads it. A body holding a construct the
/// seed keeps literal cannot be judged.
fn parse_body(markdown: &str) -> Result<Vec<SeedBlock>, Unsupported> {
    let mut blocks = Vec::new();
    let mut fallbacks = Vec::new();
    parse_chunk(markdown, &mut blocks, &mut fallbacks);
    match fallbacks.first() {
        Some(fallback) => Err(Unsupported(fallback.reason)),
        None => Ok(blocks),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_math_run_must_be_in_its_written_form() {
        let lines = ["$$", "E = mc^2", "$$"];
        let (block, end) = math_at(&lines, 0, true).expect("claimed");
        assert_eq!(end, 3);
        assert_eq!(
            block.kind,
            SeedKind::Math {
                latex: "E = mc^2".to_owned()
            }
        );
        assert!(math_at(&["$$", "x ", "$$"], 0, true).is_none());
        assert!(math_at(&["$$", "x", "$$", "after"], 0, true).is_none());
        assert!(math_at(&["$$", "x"], 0, true).is_none());
        assert!(math_at(&lines, 0, false).is_none());
    }

    #[test]
    fn only_a_lowercase_marker_with_nothing_after_it_is_a_callout() {
        assert_eq!(callout_marker("> [!note]"), Some(("note", "none")));
        assert_eq!(callout_marker("> [!tip]-"), Some(("tip", "closed")));
        assert_eq!(callout_marker("> [!NOTE]"), None);
        assert_eq!(callout_marker("> [!info] Title"), None);
    }
}
