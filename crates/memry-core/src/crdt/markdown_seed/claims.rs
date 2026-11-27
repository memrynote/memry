//! The multi-line runs `parseContentWithMarkers` claims before BlockNote's
//! parser sees them: a callout (`editor-schema/src/blocks/markdown.ts`
//! `readCalloutRun`, `resolveCalloutRun`), a `$$` math block (`readMathRun`)
//! and a structured quote (`blocks/quote.ts` `readStructuredQuoteRun`,
//! `resolveQuoteRun`).
//!
//! Desktop claims a callout or a quote when serializing the parsed body
//! reproduces its bytes, or when the canonical form it would write instead
//! settles: reads back as the same whole run and serializes to itself again.
//! Only a quote or callout that parses to one paragraph stays on the flat
//! path. [`super::roundtrip`] serializes the bodies it can serialize exactly;
//! a body holding any other block, a list, a nested quote or a comment is
//! [`Unsupported`], never guessed.

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::block_starts::ends_paragraph_before;
use super::blocks::parse_chunk;
use super::comment_nodes::has_token;
use super::prepare::fence_line;
use super::roundtrip::serialize;
use super::{SeedBlock, SeedInline, SeedKind, Unsupported};

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

/// `readCalloutRun`: a marker and the body below it.
struct CalloutRun<'a> {
    name: &'a str,
    fold: &'static str,
    /// The body, one `> ` stripped from each line (verbatim for a bare run).
    content: String,
    end: usize,
    bare: bool,
    /// Declining the body is not free, so one that does not reproduce may
    /// still claim by settling: every non-bare body read as a quote run.
    reshapes: bool,
}

/// `parseCalloutRunAt`.
pub(super) fn callout_at(
    lines: &[&str],
    start: usize,
    at_paragraph_start: bool,
) -> Result<Option<Claim>, Unsupported> {
    let Some(run) = read_callout(lines, start, at_paragraph_start)? else {
        return Ok(None);
    };
    Ok(resolve_callout(&run)?.map(|block| (block, run.end)))
}

fn read_callout<'a>(
    lines: &[&'a str],
    start: usize,
    at_paragraph_start: bool,
) -> Result<Option<CalloutRun<'a>>, Unsupported> {
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
        if let Some(run) = structured_quote_run(lines, start + 1, false) {
            if run.reshapes {
                return Err(Unsupported("callout holding a list or a nested quote"));
            }
            return Ok(Some(CalloutRun {
                name,
                fold,
                content: run.inner.join("\n"),
                end: run.end,
                bare: false,
                reshapes: true,
            }));
        }
        // No `>` line follows: a marker alone.
        return Ok(Some(CalloutRun {
            name,
            fold,
            content: String::new(),
            end: start + 1,
            bare: false,
            reshapes: false,
        }));
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
    Ok(Some(CalloutRun {
        name,
        fold: "none",
        content: lines[start + 1..end].join("\n"),
        end,
        bare: true,
        reshapes: false,
    }))
}

/// `resolveCalloutRun`: the body's first paragraph is the callout's own line,
/// the blocks after it its children.
fn resolve_callout(run: &CalloutRun) -> Result<Option<SeedBlock>, Unsupported> {
    let kind = SeedKind::Callout {
        kind: run.name.to_owned(),
        fold: run.fold.to_owned(),
    };
    if run.content.is_empty() {
        return Ok(Some(SeedBlock::new(kind, Vec::new())));
    }
    let Some(parsed) = parse_callout_body(&run.content)? else {
        return Ok(None);
    };
    let own_line = parsed[0].kind == SeedKind::Paragraph;
    let children: Vec<SeedBlock> = if own_line {
        parsed[1..].to_vec()
    } else {
        parsed.clone()
    };
    if run.bare && !children.is_empty() {
        return Ok(None);
    }
    let markdown = serialized_body(&parsed, &run.content)?;
    if markdown != run.content {
        if !run.reshapes {
            return Ok(None);
        }
        let canonical = serialize_callout(run, &markdown);
        if !callout_settles(&canonical)? {
            return Ok(None);
        }
    }
    let own = if own_line {
        parsed[0].content.clone()
    } else {
        Vec::new()
    };
    Ok(Some(SeedBlock {
        kind,
        content: own,
        children,
    }))
}

/// `parseCalloutBody` up to the serialization: the blocks, or `None` when the
/// body cannot be a callout's.
fn parse_callout_body(content: &str) -> Result<Option<Vec<SeedBlock>>, Unsupported> {
    let parsed = parse_body(content)?;
    let Some(first) = parsed.first() else {
        return Ok(None);
    };
    if parsed.iter().any(item_holds_non_list)
        || (first.kind == SeedKind::Paragraph && !first.children.is_empty())
    {
        return Ok(None);
    }
    Ok(Some(parsed))
}

/// `serializeBlocks(parsed).trim()` of a body read from `source`. Desktop
/// serializes a comment back as its source, which the masked run does not
/// hold, so a body with one is not decided.
fn serialized_body(parsed: &[SeedBlock], source: &str) -> Result<String, Unsupported> {
    if has_token(source) {
        return Err(Unsupported("comment in a callout or quote body"));
    }
    Ok(js_trim(&serialize(parsed)?).to_owned())
}

/// `serializeCalloutBlock`.
fn serialize_callout(run: &CalloutRun, markdown: &str) -> String {
    let fold = match run.fold {
        "closed" => "-",
        "open" => "+",
        _ => "",
    };
    let marker = format!("> [!{}]{fold}", run.name);
    if markdown.is_empty() {
        marker
    } else {
        format!("{marker}\n{}", requote(markdown))
    }
}

/// `serializeQuoteBlock`: one `> ` per line, a bare `>` per blank one.
fn requote(markdown: &str) -> String {
    markdown
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

/// `calloutSettles`: the canonical form reads back as one whole callout run
/// whose body serializes to itself.
fn callout_settles(canonical: &str) -> Result<bool, Unsupported> {
    let lines: Vec<&str> = canonical.split('\n').collect();
    let Some(run) = read_callout(&lines, 0, true)?.filter(|run| run.end == lines.len()) else {
        return Ok(false);
    };
    let Some(parsed) = parse_callout_body(&run.content)? else {
        return Ok(false);
    };
    Ok(serialized_body(&parsed, &run.content)? == run.content)
}

/// `readMathRun`: `$$`, the formula, `$$`, owning its whole paragraph (the
/// line after it ends a paragraph: blank, a heading, a fence, a quote, a rule,
/// a list item, a table row or a comment) and in the exact bytes
/// `serializeMathBlock` writes.
pub(super) fn math_at(lines: &[&str], start: usize, at_paragraph_start: bool) -> Option<Claim> {
    if !at_paragraph_start || lines[start] != "$$" {
        return None;
    }
    let close = start + 1 + lines[start + 1..].iter().position(|line| *line == "$$")?;
    if !ends_paragraph_before(lines.get(close + 1).copied(), lines.get(close + 2).copied()) {
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

/// `parseQuoteRunAt`: a quote run that parses to more than one paragraph, or
/// to a block other than a paragraph, becomes a quote block owning the later
/// blocks as children, claimed when its bytes reproduce or its canonical form
/// settles; a run of one paragraph stays on the flat path. A run with a `> >`
/// level or a list is [`Unsupported`], as is one holding a block this port
/// does not serialize.
pub(super) fn quote_at(lines: &[&str], start: usize) -> Result<Option<Claim>, Unsupported> {
    let Some(run) = structured_quote_run(lines, start, true) else {
        return Ok(None);
    };
    if run.reshapes {
        return Err(Unsupported("quote holding a list or a nested quote"));
    }
    let inner = run.inner.join("\n");
    let parsed = parse_body(&inner)?;
    let Some((content, children)) = split_quote_blocks(&parsed) else {
        return Ok(None);
    };
    let canonical = requote(&serialized_body(&parsed, &inner)?);
    if canonical != lines[start..run.end].join("\n") && !quote_settles(&canonical)? {
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

/// `splitQuoteBlocks`, for a body without a list: a leading paragraph is the
/// quote's own line and the rest its children; a body that opens on any other
/// block has no own line. One paragraph alone, a first block with children,
/// and no block at all are `None`.
fn split_quote_blocks(parsed: &[SeedBlock]) -> Option<(Vec<SeedInline>, Vec<SeedBlock>)> {
    let first = parsed.first()?;
    if !first.children.is_empty() {
        return None;
    }
    if first.kind != SeedKind::Paragraph {
        return Some((Vec::new(), parsed.to_vec()));
    }
    (parsed.len() > 1).then(|| (first.content.clone(), parsed[1..].to_vec()))
}

/// `settles`: the canonical form reads back as one whole quote run whose
/// blocks serialize to it again.
fn quote_settles(canonical: &str) -> Result<bool, Unsupported> {
    let lines: Vec<&str> = canonical.split('\n').collect();
    let Some(run) = structured_quote_run(&lines, 0, false).filter(|run| run.end == lines.len())
    else {
        return Ok(false);
    };
    if run.reshapes {
        return Err(Unsupported("quote holding a list or a nested quote"));
    }
    let inner = run.inner.join("\n");
    let parsed = parse_body(&inner)?;
    if split_quote_blocks(&parsed).is_none() {
        return Ok(false);
    }
    Ok(requote(&serialized_body(&parsed, &inner)?) == canonical)
}

/// `readStructuredQuoteRun`: a run of `>` lines, with one level stripped. A
/// `>text` line refuses the run. `reshapes` marks a `> >` level or a list item
/// (which the source also tracks fences for); both are refused, so a superset
/// is enough. With `lazy_paragraph`, a quote's last paragraph takes the lines
/// after it that open no block, as BlockNote's flat quote does; a callout's
/// body ends at its last `>` line.
fn structured_quote_run(lines: &[&str], start: usize, lazy_paragraph: bool) -> Option<QuoteRun> {
    if !lines.get(start)?.starts_with('>') {
        return None;
    }
    let mut inner: Vec<String> = Vec::new();
    let mut end = start;
    let mut reshapes = false;
    while let Some(line) = lines.get(end).filter(|line| line.starts_with('>')) {
        if *line == ">" {
            inner.push(String::new());
        } else {
            // The marker's space is optional: `>b` is a quote line too.
            let stripped = line.strip_prefix("> ").unwrap_or(&line[1..]);
            inner.push(stripped.to_owned());
            reshapes |= stripped.starts_with('>') || looks_like_list_item(stripped);
        }
        end += 1;
    }
    let last = inner.last().map_or("", String::as_str);
    if lazy_paragraph
        && !last.is_empty()
        && !is_block_start(last)
        && !inner.iter().any(|line| fence_line(line).is_some())
    {
        while let Some(line) = lines.get(end).filter(|line| {
            !js_trim(line).is_empty() && !looks_like_list_item(line) && !is_block_start(line)
        }) {
            inner.push((*line).to_owned());
            end += 1;
        }
    }
    Some(QuoteRun {
        inner,
        end,
        reshapes,
    })
}

/// `LIST_ITEM`, `/^ {0,3}([-*+]|\d{1,9}[.)])([ \t]|$)/`, a superset of
/// `INTERRUPTING_ITEM`.
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
                Some(after) if (1..=9).contains(&digits) => after,
                _ => return false,
            }
        }
    };
    after.is_empty() || after.starts_with([' ', '\t'])
}

/// `BLOCK_START`, a line that starts a block of its own instead of continuing
/// a paragraph:
/// `/^ {0,3}(>|#{1,6}([ \t]|$)|```|~~~|<|\||[-*_=]+[ \t]*$|[-*_]([ \t]*[-*_]){2,}[ \t]*$)/`.
fn is_block_start(line: &str) -> bool {
    let rest = line.trim_start_matches(' ');
    if line.len() - rest.len() > 3 {
        return false;
    }
    let hashes = rest.chars().take_while(|c| *c == '#').count();
    let ruled = rest.trim_end_matches([' ', '\t']);
    let marks = ruled
        .chars()
        .filter(|c| matches!(c, '-' | '*' | '_'))
        .count();
    rest.starts_with(['>', '<', '|'])
        || rest.starts_with("```")
        || rest.starts_with("~~~")
        || ((1..=6).contains(&hashes)
            && rest[hashes..]
                .chars()
                .next()
                .is_none_or(|c| matches!(c, ' ' | '\t')))
        || (!ruled.is_empty() && ruled.chars().all(|c| matches!(c, '-' | '*' | '_' | '=')))
        || (marks >= 3
            && rest.starts_with(['-', '*', '_'])
            && ruled
                .chars()
                .all(|c| matches!(c, '-' | '*' | '_' | ' ' | '\t')))
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
        // The parser ends a paragraph before a line a setext underline sits under.
        assert!(math_at(&["$$", "y", "$$", "H", "---"], 0, true).is_some());
        assert!(math_at(&["$$", "y", "$$", "H", "==="], 0, true).is_some());
        assert!(math_at(&["$$", "y", "$$", "H", "text"], 0, true).is_none());
    }

    #[test]
    fn a_quotes_last_paragraph_takes_the_lazy_lines_that_open_no_block() {
        let run = |lines: &[&str], lazy| {
            let run = structured_quote_run(lines, 0, lazy).expect("a run");
            (run.inner, run.end)
        };
        let (inner, end) = run(
            &["> q", "> ", ">", "> r", "lazy", "more", "", "after"],
            true,
        );
        assert_eq!((inner.last().map(String::as_str), end), (Some("more"), 6));
        // A callout's body ends at its last `>` line.
        assert_eq!(run(&["> q", "lazy"], false).1, 1);
        // A line that opens a block, or a last line that does, ends the run.
        assert_eq!(run(&["> q", "# h"], true).1, 1);
        assert_eq!(run(&["> q", "lazy", "- a"], true).1, 2);
        assert_eq!(run(&["> # h", "z"], true).1, 1);
        assert_eq!(run(&["> q", "> ```", "> x", "> ```", "z"], true).1, 4);
        assert_eq!(run(&["> q", "z", "    code"], true).1, 3);
        assert_eq!(run(&["> q", "a | b"], true).1, 2);
    }

    #[test]
    fn only_a_lowercase_marker_with_nothing_after_it_is_a_callout() {
        assert_eq!(callout_marker("> [!note]"), Some(("note", "none")));
        assert_eq!(callout_marker("> [!tip]-"), Some(("tip", "closed")));
        assert_eq!(callout_marker("> [!NOTE]"), None);
        assert_eq!(callout_marker("> [!info] Title"), None);
    }
}
