//! Desktop's text passes around BlockNote's parser, for the constructs this
//! seed supports.
//!
//! Each function mirrors one step of `blocknote-converter.ts`'s
//! `markdownToYFragment` path and names its source. Steps that only act on a
//! construct this seed does not support (toggles, callouts, colour spans,
//! link references, CriticMarkup, inline tokens) are not ported: their
//! presence routes the text to the fallback instead ([`document_fallback`],
//! [`line_fallback`]).

use crate::domain::journal_rules::js_trim;

/// Why a whole document is kept as literal text, or `None` when it can be
/// parsed. These constructs change how desktop splits or rewrites the whole
/// text before any block is read, so a block-level fallback cannot contain
/// them.
pub(super) fn document_fallback(markdown: &str) -> Option<&'static str> {
    // JS line terminators other than `\n`, which the desktop regexes treat as
    // line ends while `split('\n')` does not; NUL and the object replacement
    // character, which the HTML parser and BlockNote rewrite.
    if markdown.contains(['\r', '\0', '\u{2028}', '\u{2029}', '\u{FFFC}']) {
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
    let lower = markdown.to_ascii_lowercase();
    if lower.contains("<details") || lower.contains("</details") || lower.contains("<summary") {
        return Some("toggle");
    }
    if markdown.split('\n').any(is_link_reference_definition) {
        return Some("link reference definition");
    }
    None
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
    if line.contains("![") {
        return Some("image or embed");
    }
    let chars: Vec<char> = line.chars().collect();
    if chars.windows(2).any(|pair| {
        pair[0] == '<' && (pair[1].is_ascii_alphabetic() || matches!(pair[1], '/' | '!' | '?'))
    }) {
        return Some("HTML");
    }
    if line.contains("[!") {
        return Some("callout");
    }
    if line.contains("$$") {
        return Some("math");
    }
    if line.contains("((mention:") || line.contains("((date:") {
        return Some("inline token");
    }
    if line.contains("{task:") {
        return Some("task block");
    }
    if line == ">" || line.starts_with("> >") {
        return Some("structured quote");
    }
    let trimmed = js_trim(line);
    if trimmed.len() >= 2 && trimmed.starts_with('|') && trimmed.ends_with('|') {
        return Some("table");
    }
    None
}

/// The markdown half of `splitMarkdownByToggles` for a document with no
/// toggle: the text between leading and trailing blank lines, `trim()`med,
/// and the empty paragraphs the trailing blank lines beyond the first carry.
pub(super) fn toggle_segment(markdown: &str) -> Option<(String, usize)> {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let first = lines
        .iter()
        .take_while(|line| js_trim(line).is_empty())
        .count();
    let mut after_last = lines.len();
    while after_last > first && js_trim(lines[after_last - 1]).is_empty() {
        after_last -= 1;
    }
    let text = js_trim(&lines[first..after_last].join("\n")).to_owned();
    if text.is_empty() {
        return None;
    }
    let trailing = lines.len() - after_last;
    Some((text, trailing.saturating_sub(1)))
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

/// `maskHardBreaks` (`shared/empty-lines.ts`): a line ending in two spaces or
/// tabs, or in a backslash, followed by a non-blank line, has that spelling
/// replaced by `MEMRYHBK<n>;`. Returns the text and the spellings.
pub(super) fn mask_hard_breaks(markdown: &str) -> (String, Vec<String>) {
    let mut breaks = Vec::new();
    let masked: String = split_by_code_fences(markdown)
        .into_iter()
        .map(|(text, is_code)| {
            if is_code || (!text.contains("  ") && !text.contains('\t') && !text.contains('\\')) {
                return text.to_owned();
            }
            let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
            for index in 0..lines.len().saturating_sub(1) {
                if js_trim(&lines[index + 1]).is_empty() || js_trim(&lines[index]).is_empty() {
                    continue;
                }
                let line = &lines[index];
                let blanks = line.len() - line.trim_end_matches([' ', '\t']).len();
                let spelling = if blanks >= 2 {
                    blanks
                } else if blanks == 0 && line.ends_with('\\') {
                    1
                } else {
                    continue;
                };
                let cut = line.len() - spelling;
                breaks.push(line[cut..].to_owned());
                lines[index] = format!("{}MEMRYHBK{};", &line[..cut], breaks.len() - 1);
            }
            lines.join("\n")
        })
        .collect();
    if breaks.is_empty() {
        (markdown.to_owned(), breaks)
    } else {
        (masked, breaks)
    }
}

/// `unmaskHardBreaks`: a token followed by a newline becomes two newlines, a
/// token that lost its newline is deleted.
pub(super) fn unmask_hard_breaks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("MEMRYHBK") {
        let after = &rest[start + "MEMRYHBK".len()..];
        let digits = after.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 || !after[digits..].starts_with(';') {
            out.push_str(&rest[..start + "MEMRYHBK".len()]);
            rest = after;
            continue;
        }
        out.push_str(&rest[..start]);
        let tail = &after[digits + 1..];
        if let Some(tail) = tail.strip_prefix('\n') {
            out.push_str("\n\n");
            rest = tail;
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

/// `restoreHardBreakSpelling`: every token back to the spelling it replaced.
pub(super) fn restore_hard_break_spelling(text: &str, breaks: &[String]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("MEMRYHBK") {
        let after = &rest[start + "MEMRYHBK".len()..];
        let digits = after.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 || !after[digits..].starts_with(';') {
            out.push_str(&rest[..start + "MEMRYHBK".len()]);
            rest = after;
            continue;
        }
        out.push_str(&rest[..start]);
        let spelling = after[..digits]
            .parse::<usize>()
            .ok()
            .and_then(|index| breaks.get(index));
        if let Some(spelling) = spelling {
            out.push_str(spelling);
        }
        rest = &after[digits + 1..];
    }
    out.push_str(rest);
    out
}

/// `listCodeFenceInfoStrings` (`shared/markdown-fences.ts`): every fence's
/// info string in document order, `""` for an untagged one.
pub(super) fn code_fence_info_strings(markdown: &str) -> Vec<String> {
    let mut open: Option<(char, usize)> = None;
    let mut infos = Vec::new();
    for line in markdown.split('\n') {
        let Some((fence_char, length, info)) = fence_line(line) else {
            continue;
        };
        match open {
            None => {
                if fence_char == '`' && info.contains('`') {
                    continue;
                }
                open = Some((fence_char, length));
                infos.push(js_trim(info).to_owned());
            }
            Some((char, open_length)) => {
                if fence_char == char && length >= open_length && js_trim(info).is_empty() {
                    open = None;
                }
            }
        }
    }
    infos
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
    fn trailing_blank_lines_beyond_the_first_become_empty_paragraphs() {
        assert_eq!(toggle_segment("a\n"), Some(("a".to_owned(), 0)));
        assert_eq!(toggle_segment("a\n\n"), Some(("a".to_owned(), 1)));
        assert_eq!(toggle_segment("\n\n  a  \n\n\n"), Some(("a".to_owned(), 2)));
        assert_eq!(toggle_segment(" \n\n"), None);
    }

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
    fn a_hard_break_spelling_round_trips_through_its_token() {
        let (masked, breaks) = mask_hard_breaks("a  \nb\\\nc  \n\nd");
        assert_eq!(masked, "aMEMRYHBK0;\nbMEMRYHBK1;\nc  \n\nd");
        assert_eq!(breaks, vec!["  ".to_owned(), "\\".to_owned()]);
        assert_eq!(unmask_hard_breaks("aMEMRYHBK0;\nb"), "a\n\nb");
        assert_eq!(unmask_hard_breaks("aMEMRYHBK0;"), "a");
        assert_eq!(
            restore_hard_break_spelling(&masked, &breaks),
            "a  \nb\\\nc  \n\nd"
        );
    }

    #[test]
    fn indented_code_after_a_blank_line_is_fenced() {
        assert_eq!(fence_indented_code("p\n\n    x"), "p\n\n```\nx\n```");
        assert_eq!(fence_indented_code("- a\n\n    x"), "- a\n\n    x");
        assert_eq!(fence_indented_code("    x"), "```\nx\n```");
    }

    #[test]
    fn untagged_fences_report_an_empty_info_string() {
        assert_eq!(
            code_fence_info_strings("```\na\n```\n~~~ py \nb\n~~~"),
            vec![String::new(), "py".to_owned()]
        );
    }
}
