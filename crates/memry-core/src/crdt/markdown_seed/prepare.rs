//! Desktop's text passes around BlockNote's parser.
//!
//! Each function mirrors one step of `blocknote-converter.ts`'s
//! `markdownToYFragment` path and names its source. Steps that only act on a
//! construct this seed does not build (colour spans, link references,
//! CriticMarkup, column regions, HTML comments, inline tokens) are not
//! ported: their presence routes the text to the fallback instead
//! ([`document_fallback`], [`line_fallback`]).

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::block_starts::ends_paragraph_before;
use super::markers::FenceTracker;
use super::shapes::{leading_ws, skip_chars};

/// Why a whole document is kept as literal text, or `None` when it can be
/// parsed. These constructs change how desktop splits or rewrites the whole
/// text before any block is read, so a block-level fallback cannot contain
/// them.
pub(super) fn document_fallback(markdown: &str) -> Option<&'static str> {
    // JS line terminators other than `\n`, which the desktop regexes treat as
    // line ends while `split('\n')` does not; NUL and the object replacement
    // character, which the HTML parser and BlockNote rewrite; and the
    // character the hard-break mask joins list-item lines with
    // ([`super::hard_breaks::JOIN`]), which no source may already hold.
    if markdown.contains(['\0', '\u{1}', '\u{2028}', '\u{2029}', '\u{FFFC}']) {
        return Some("line terminator or control character");
    }
    // The masking tokens desktop inserts and restores (`MEMRYHBK`, `MEMRYICO`,
    // `MEMRYDLT`, `MEMRYTKN`): source text holding one would be rewritten.
    if markdown.contains("MEMRY") {
        return Some("masking token text");
    }
    if ["{++", "{--", "{~~", "{==", "{>>"]
        .iter()
        .any(|open| markdown.contains(open))
    {
        return Some("CriticMarkup");
    }
    if markdown.split('\n').any(opens_column_region) {
        return Some("columns");
    }
    if markdown.split('\n').any(is_link_reference_definition) {
        return Some("link reference definition");
    }
    // A marker sets the level of the text after it, and desktop lifts a run
    // indented under an item into the marker form: neither is read here.
    if markdown.split('\n').any(is_nesting_marker) {
        return Some("block nesting marker");
    }
    if lifts_item_child_run(markdown) {
        return Some("list item holding a callout, quote or math block");
    }
    None
}

/// A superset of `BLOCK_NESTING_MARKER_REGEX`
/// (`shared/block-nesting.ts`), `/^<!--\s*memry:block-nesting-level=(\d+)\s*-->$/`,
/// which also matches one inside a fence.
fn is_nesting_marker(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("<!--") else {
        return false;
    };
    let Some(rest) = rest
        .trim_start_matches(is_js_whitespace)
        .strip_prefix("memry:block-nesting-level=")
    else {
        return false;
    };
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && rest[digits..].trim_start_matches(is_js_whitespace) == "-->"
}

/// `ITEM` of `liftItemChildRuns` (`blocks/item-children.ts`), `/^([-*+]|\d{1,9}[.)])
/// (?:( {1,4})(?=\S)|[ \t]*$)/`: a top-level item's content column.
fn item_column(line: &str) -> Option<usize> {
    let marker = if line.starts_with(['-', '*', '+']) {
        1
    } else {
        let digits = line.chars().take_while(char::is_ascii_digit).count();
        if !(1..=9).contains(&digits) || !line[digits..].starts_with(['.', ')']) {
            return None;
        }
        digits + 1
    };
    let rest = &line[marker..];
    let spaces = rest.chars().take_while(|c| *c == ' ').count();
    let text_follows = rest[spaces..]
        .chars()
        .next()
        .is_some_and(|c| !is_js_whitespace(c));
    if (1..=4).contains(&spaces) && text_follows {
        Some(marker + spaces)
    } else if rest.chars().all(|c| matches!(c, ' ' | '\t')) {
        Some(marker + 1)
    } else {
        None
    }
}

/// Whether `liftItemChildRuns` would lift a run: a line indented at least as
/// far as an open top-level item's text, after a blank line, whose deindented
/// text starts with `>` or is `$$`. A fence is skipped, and so is anything but
/// a top-level item. Stops at the first, so what the lift does to the lines
/// after it is not followed.
fn lifts_item_child_run(markdown: &str) -> bool {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut fence = FenceTracker::default();
    // The open top-level item's content column, or 0 outside a list.
    let mut column = 0;
    for (index, line) in lines.iter().enumerate() {
        let after_blank = index > 0 && js_trim(lines[index - 1]).is_empty();
        if fence.consume(line) || js_trim(line).is_empty() {
            continue;
        }
        let indent = leading_ws(line);
        if indent == 0 {
            if let Some(found) = item_column(line) {
                column = found;
            } else if after_blank || ends_paragraph_before(Some(line), None) {
                column = 0;
            }
            continue;
        }
        let inner = skip_chars(line, column);
        if column > 0
            && after_blank
            && indent >= column
            && (inner.starts_with('>') || inner == "$$")
        {
            return true;
        }
    }
    false
}

/// A superset of the lines `readColumnRegion` (`blocks/columns.ts`) opens a
/// region on, matched on the raw line as it is: `MCM_START_REGEX`, and a
/// Pandoc `:::` fence whose descriptor names a columns class.
fn opens_column_region(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    if let Some(rest) = lower
        .strip_prefix("---")
        .or_else(|| lower.strip_prefix("==="))
    {
        let rest = rest.trim_start_matches(crate::domain::journal_rules::is_js_whitespace);
        return rest.starts_with("start-multi-column") || rest.starts_with("multi-column-start");
    }
    lower.starts_with(":::") && lower.contains("column")
}

/// A superset of `DEFINITION_LINE` (`shared/link-references.ts`): up to three
/// spaces, `[label]:` with a label that is not a footnote, then a destination.
fn is_link_reference_definition(line: &str) -> bool {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    if indent > 3 {
        return false;
    }
    let mut chars = line[indent..].chars();
    if chars.next() != Some('[') {
        return false;
    }
    let rest: Vec<char> = chars.collect();
    if rest.first() == Some(&'^') {
        return false;
    }
    let mut index = 0;
    while index < rest.len() {
        match rest[index] {
            '\\' => index += 2,
            '[' => return false,
            ']' => break,
            _ => index += 1,
        }
    }
    if index == 0 || index >= rest.len() || rest.get(index + 1) != Some(&':') {
        return false;
    }
    rest[index + 2..].iter().any(|c| !c.is_whitespace())
}

/// Why one line sends its block to the fallback, or `None`. A conservative
/// superset of the line shapes desktop claims outside BlockNote's parser or
/// that BlockNote turns into a block this seed does not build.
pub(super) fn line_fallback(line: &str) -> Option<&'static str> {
    let chars: Vec<char> = line.chars().collect();
    if chars.windows(2).any(|pair| {
        pair[0] == '<' && (pair[1].is_ascii_alphabetic() || matches!(pair[1], '/' | '!' | '?'))
    }) {
        return Some("HTML");
    }
    if line.contains("((mention:") || line.contains("((date:") {
        return Some("inline token");
    }
    if line.contains("{task:") {
        return Some("task block");
    }
    // Desktop strips the marker into the `plain` prop
    // (`shared/src/plain-checkbox.ts`); kept as text it would be a line the
    // user never typed.
    if line.contains("{check}") {
        return Some("plain checkbox");
    }
    if line == ">" || line.starts_with("> >") {
        return Some("structured quote");
    }
    None
}

/// One piece of `splitMarkdownPreservingBlanks`.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Piece {
    Content(String),
    /// Empty paragraphs: blank lines beyond the one a paragraph break takes.
    Gap(usize),
}

/// `splitMarkdownPreservingBlanks` (`shared/empty-lines.ts`): runs of three or
/// more newlines outside a code fence become gaps.
pub(super) fn split_preserving_blanks(markdown: &str) -> Vec<Piece> {
    if js_trim(markdown).is_empty() {
        return Vec::new();
    }
    let mut pieces = Vec::new();
    let mut current = String::new();
    for (text, is_code) in split_by_code_fences(markdown) {
        if is_code {
            current.push_str(text);
            continue;
        }
        let mut rest = text;
        while let Some(start) = rest.find("\n\n\n") {
            let run = rest[start..].chars().take_while(|c| *c == '\n').count();
            current.push_str(&rest[..start]);
            pieces.push(Piece::Content(std::mem::take(&mut current)));
            pieces.push(Piece::Gap(run - 2));
            rest = &rest[start + run..];
        }
        current.push_str(rest);
    }
    pieces.push(Piece::Content(current));
    pieces
        .into_iter()
        .filter_map(|piece| match piece {
            Piece::Content(text) => {
                let text = text.trim_matches('\n');
                (!text.is_empty()).then(|| Piece::Content(text.to_owned()))
            }
            gap => Some(gap),
        })
        .collect()
}

/// `splitByCodeFences` (`shared/empty-lines.ts`): regions of text and whether
/// each is inside a fence. A fence opens on a line starting (after up to three
/// spaces) with ```` ``` ```` or `~~~` and closes on the next such line with
/// the same three characters, through the end of that line.
pub(super) fn split_by_code_fences(markdown: &str) -> Vec<(&str, bool)> {
    let mut regions = Vec::new();
    let mut open: Option<&str> = None;
    let mut last = 0;
    let mut line_start = 0;
    for line in markdown.split('\n') {
        let fence = fence_prefix(line);
        match (open, fence) {
            (None, Some(fence)) => {
                if line_start > last {
                    regions.push((&markdown[last..line_start], false));
                }
                open = Some(fence);
                last = line_start;
            }
            (Some(current), Some(fence)) if current == fence => {
                let end = line_start + line.len();
                regions.push((&markdown[last..end], true));
                open = None;
                last = end;
            }
            _ => {}
        }
        line_start += line.len() + 1;
    }
    if last < markdown.len() {
        regions.push((&markdown[last..], open.is_some()));
    }
    regions
}

/// `^( {0,3})(```|~~~)`: the three fence characters, when the line opens one.
fn fence_prefix(line: &str) -> Option<&'static str> {
    let indent = line.chars().take_while(|c| *c == ' ').count().min(3);
    let rest = &line[indent..];
    if rest.starts_with("```") {
        Some("```")
    } else if rest.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

/// `^(?: {4}|\t)`: the prefix an indented code line carries.
fn indented_code_body(line: &str) -> Option<&str> {
    line.strip_prefix("    ")
        .or_else(|| line.strip_prefix('\t'))
}

/// `^[ \t]*(?:[-*+]|\d+[.)])\s`.
fn is_list_item_line(line: &str) -> bool {
    let rest = line.trim_start_matches([' ', '\t']);
    let after = if let Some(after) = rest.strip_prefix(['-', '*', '+']) {
        after
    } else {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        match rest[digits..].strip_prefix(['.', ')']) {
            Some(after) => after,
            None => return false,
        }
    };
    after
        .chars()
        .next()
        .is_some_and(crate::domain::journal_rules::is_js_whitespace)
}

/// `fenceIndentedCodeBlocks` (`shared/empty-lines.ts`): an indented code run
/// that opens after a blank line (not under a list item) becomes a fence.
pub(super) fn fence_indented_code(markdown: &str) -> String {
    let single_indented_line = !markdown.contains('\n') && indented_code_body(markdown).is_some();
    if !markdown.contains("\n ") && !markdown.contains("\n\t") && !single_indented_line {
        return markdown.to_owned();
    }
    split_by_code_fences(markdown)
        .into_iter()
        .map(|(text, is_code)| {
            if is_code {
                text.to_owned()
            } else {
                fence_prose_indented_code(text)
            }
        })
        .collect()
}

fn fence_prose_indented_code(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut previous_non_blank: Option<String> = None;
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let opens = !js_trim(line).is_empty()
            && indented_code_body(line).is_some()
            && (previous_non_blank.is_none()
                || index
                    .checked_sub(1)
                    .is_some_and(|before| js_trim(lines[before]).is_empty()))
            && !previous_non_blank.as_deref().is_some_and(is_list_item_line);
        if !opens {
            out.push(line.to_owned());
            if !js_trim(line).is_empty() {
                previous_non_blank = Some(line.to_owned());
            }
            index += 1;
            continue;
        }
        let end = indented_run_end(&lines, index);
        out.push("```".to_owned());
        for body in &lines[index..end] {
            out.push(indented_code_body(body).unwrap_or(body).to_owned());
        }
        out.push("```".to_owned());
        previous_non_blank = Some("```".to_owned());
        index = end;
    }
    out.join("\n")
}

fn indented_run_end(lines: &[&str], start: usize) -> usize {
    let mut end = start + 1;
    let mut last_content = end;
    while end < lines.len() {
        if indented_code_body(lines[end]).is_some() {
            end += 1;
            last_content = end;
        } else if js_trim(lines[end]).is_empty() {
            end += 1;
        } else {
            break;
        }
    }
    last_content
}

/// `^ {0,3}(`{3,}|~{3,})(.*)$`: the fence character, the run length and the
/// rest of the line.
pub(super) fn fence_line(line: &str) -> Option<(char, usize, &str)> {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let fence_char = rest.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let length = rest.chars().take_while(|c| *c == fence_char).count();
    (length >= 3).then(|| (fence_char, length, &rest[length..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_newlines_outside_a_fence_split_a_gap() {
        assert_eq!(
            split_preserving_blanks("a\n\n\n\nb"),
            vec![
                Piece::Content("a".to_owned()),
                Piece::Gap(2),
                Piece::Content("b".to_owned())
            ]
        );
        assert_eq!(
            split_preserving_blanks("```\na\n\n\n\nb\n```"),
            vec![Piece::Content("```\na\n\n\n\nb\n```".to_owned())]
        );
    }

    #[test]
    fn only_a_column_region_opener_sends_the_document_to_columns() {
        for opener in [
            "--- start-multi-column: a1",
            "=== MULTI-COLUMN-START",
            "::: columns",
            ":::: {.two-columns}",
        ] {
            let markdown = format!("# T\n\n{opener}\nleft");
            assert_eq!(document_fallback(&markdown), Some("columns"), "{opener}");
        }
        for prose in [
            "a multi-column layout",
            "::: note\nbody\n:::",
            " --- start-multi-column: a1",
        ] {
            assert_eq!(document_fallback(prose), None, "{prose}");
        }
    }

    #[test]
    fn indented_code_after_a_blank_line_is_fenced() {
        assert_eq!(fence_indented_code("p\n\n    x"), "p\n\n```\nx\n```");
        assert_eq!(fence_indented_code("- a\n\n    x"), "- a\n\n    x");
        assert_eq!(fence_indented_code("    x"), "```\nx\n```");
    }
}
