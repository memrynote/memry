//! Hard-break masking around BlockNote's parser: `shared/hard-breaks.ts`.
//!
//! BlockNote's parser prints a soft and a hard break alike, so the spelling is
//! carried across it as `MEMRYHBK<n>;` and given back afterwards: as the second
//! newline of a hard break in prose ([`unmask_hard_breaks`]), as the author's
//! own bytes in a code block or a string prop ([`restore_hard_break_spelling`]).
//! Source holding the token text never gets here (`prepare::document_fallback`).
//!
//! Desktop joins a list item's continuation line to the line above with a
//! literal `<br>` so a break there survives (BBF-99, BBF-106). This port cannot
//! write one: `line_fallback` and the inline parse read `<` and a letter as
//! HTML. The join is the one character [`JOIN`] instead, which
//! `document_fallback` keeps out of the source and `inline::inline_token`
//! parses to a bare `Html::Br`, exactly what BlockNote does with a raw `<br>`.
//! Every join decision reads a line through [`seen`], where [`JOIN`] is the
//! `<br>` desktop would see, so an author's `<br>` and a join weigh the same.
//!
//! A table row is never masked: its trailing `\` or spaces stay the last cell's
//! text, as in desktop's `inTable`.
//!
//! Not ported: `HTML_BREAK_MID_LINE`, `inOtherBlock` and `NOT_PARAGRAPH_LINE`,
//! desktop's marking of an author's `<br>` mid-line. A line holding HTML sends
//! its block to the fallback, which drops the tokens again, and the marking
//! never applies on a list-item line or after one (`NOT_PARAGRAPH_LINE` holds
//! its `- ` and its indent, and only a blank line clears `inOtherBlock`), so no
//! join decision reads a token it wrote.

use std::sync::LazyLock;

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::mask_word::mask_word;
use super::prepare::split_by_code_fences;
use super::shapes::is_table_separator;

/// The `<br>` of desktop's list-item join. Never in source text.
pub(super) const JOIN: char = '\u{1}';

/// `MEMRYHBK` and the process's mask word: no source text spells a token.
fn token_prefix() -> &'static str {
    static PREFIX: LazyLock<String> = LazyLock::new(|| format!("MEMRYHBK{}", mask_word()));
    &PREFIX
}

/// `maskHardBreaks`: a line ending in two or more spaces or tabs, or in a
/// backslash, followed by a non-blank line, has that spelling replaced by
/// `MEMRYHBK<n>;`, outside code fences. Returns the text and the spellings.
pub(super) fn mask_hard_breaks(markdown: &str) -> (String, Vec<String>) {
    let mut breaks = Vec::new();
    let mut out = String::with_capacity(markdown.len());
    for (text, is_code) in split_by_code_fences(markdown) {
        if is_code {
            out.push_str(text);
        } else {
            out.push_str(&mask_prose(text, &mut breaks));
        }
    }
    (out, breaks)
}

/// `maskProseHardBreaks`, without the `<br>` marking (module docs).
///
/// Desktop joins into `lines[index]` and removes the line it took; here the
/// line under construction is moved out, the lines it took are left behind
/// `next`, and [`OpenLine`] keeps what every later decision reads of it, so a
/// join costs the length of the line it takes and no more.
fn mask_prose(text: &str, breaks: &mut Vec<String>) -> String {
    // The cheap reject: only these can spell a break or a link join. `<br` is
    // not among them, since only the marking it drives is not ported.
    if !text.contains("  ") && !text.contains(['\t', '\\']) && !text.contains("](") {
        return text.to_owned();
    }
    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut in_list_item = false;
    let mut in_table = false;
    let mut at = 0;
    while at < lines.len() {
        let mut line = std::mem::take(&mut lines[at]);
        let mut open = OpenLine::new(&line);
        let mut next = at + 1;
        loop {
            // A table row is one line, so a `\` ending it is the last cell's text.
            // A pipe line above a delimiter row opens a table; it runs on until a
            // line without a pipe.
            let after = lines.get(next).map_or("", String::as_str);
            if !open.has_pipe {
                in_table = false;
            } else if after.contains('|') && is_table_separator(after) {
                in_table = true;
            }
            if is_blank(&line) {
                in_list_item = false;
            } else if list_item_start(&line) {
                in_list_item = true;
            } else if block_start(&line) {
                in_list_item = false;
            }
            if next == lines.len() || is_blank(&lines[next]) {
                break;
            }
            let spelling = hard_break_spelling(&line).map(str::len);
            // The parser ends a list item at a soft break inside link text too,
            // so `- [a\nb](u)` lost its link and gained a blank line (BBF-106).
            if in_list_item && spelling.is_none() && !block_start(&lines[next]) {
                let end = match open.link_end {
                    Some(end) => (open.depth > 0 && next < end).then_some(end),
                    None => ends_inside_link_text(open.depth, &line, &lines[next..])
                        .map(|len| next + len),
                };
                if let Some(end) = end {
                    open.join(&mut line, &mut lines[next]);
                    next += 1;
                    open.link_end = Some(end);
                    open.unclean = true;
                    continue;
                }
            }
            let spelling = spelling.filter(|_| !in_table && !is_blank(&line));
            let Some(spelling) = spelling else {
                break;
            };
            // The token replaces the spelling: two trailing spaces left in place
            // would hand the parser a break it already drops, and a backslash
            // would escape the token's first character.
            breaks.push(line[line.len() - spelling..].to_owned());
            line.truncate(line.len() - spelling);
            line.push_str(&format!("{}{};", token_prefix(), breaks.len() - 1));
            // A list item's continuation line becomes a child paragraph, or a lazy
            // one ends the list, so the break is lost (BBF-99). Joined, the token
            // lands against the item's soft break; the joined line is read again.
            // A span the join would carry across keeps the split.
            if in_list_item
                && !block_start(&lines[next])
                && !open.unclean
                && !lines[next].contains(JOIN_BLOCKERS)
            {
                open.join(&mut line, &mut lines[next]);
                next += 1;
                open.link_end = None;
                continue;
            }
            break;
        }
        out.push(line);
        at = next;
    }
    out.join("\n")
}

/// What a join keeps from a code span, a link or a tag.
const JOIN_BLOCKERS: [char; 4] = ['`', '[', ']', '<'];

/// What [`mask_prose`] reads of the line it is building, kept as the line
/// grows.
struct OpenLine {
    /// The line holds a pipe.
    has_pipe: bool,
    /// How many `[` the line leaves open (the task box's own pair adds none).
    depth: usize,
    /// The line holds a character a join must not carry across, outside its
    /// task box and the joins this port made after a token. Such a join stays
    /// as [`JOIN`], which desktop reads as `<br>`, so it counts as a tag.
    unclean: bool,
    /// Set after a join over link text: where the paragraph that holds the
    /// text ends. Each such join leaves the rest of the paragraph's lines out
    /// of what [`ends_inside_link_text`] refuses on, and adds to the line only
    /// what it already accepted, so the next join over the same text is
    /// decided by `depth` and the lines left alone.
    link_end: Option<usize>,
}

impl OpenLine {
    fn new(line: &str) -> Self {
        let boxed = task_item_box(line).map_or(0, |(_, end)| end);
        let mut open = Self {
            has_pipe: false,
            depth: 0,
            unclean: line[boxed..].contains(JOIN_BLOCKERS),
            link_end: None,
        };
        open.take(line);
        open
    }

    fn take(&mut self, text: &str) {
        self.has_pipe |= text.contains('|');
        for c in text.chars() {
            match c {
                '[' => self.depth += 1,
                ']' => self.depth = self.depth.saturating_sub(1),
                _ => {}
            }
        }
    }

    /// `lines[index] += '<br>' + lines[index + 1].trimStart()`: `line` takes
    /// `next`, which is left empty.
    fn join(&mut self, line: &mut String, next: &mut String) {
        let next = std::mem::take(next);
        let text = next.trim_start_matches(is_js_whitespace);
        line.push(JOIN);
        line.push_str(text);
        self.take(text);
    }
}

/// `line.trim() === ''`.
fn is_blank(line: &str) -> bool {
    js_trim(line).is_empty()
}

/// `[^\S\n]`.
fn is_inline_space(c: char) -> bool {
    c != '\n' && is_js_whitespace(c)
}

/// A line as desktop's regexes see it: each [`JOIN`] is the `<br>` it stands for.
fn seen(line: &str) -> String {
    line.replace(JOIN, "<br>")
}

/// `HARD_BREAK_LINE`, `/(?:[ \t]{2,}|\\)$/`: the spelling the line ends in.
fn hard_break_spelling(line: &str) -> Option<&str> {
    let trailing = line.len() - line.trim_end_matches([' ', '\t']).len();
    if trailing >= 2 {
        Some(&line[line.len() - trailing..])
    } else if line.ends_with('\\') {
        Some("\\")
    } else {
        None
    }
}

/// `TASK_ITEM_BOX`, `/^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[[ xX]\]/`: where the
/// group ends and where the whole match does.
fn task_item_box(line: &str) -> Option<(usize, usize)> {
    let prefix = list_marker(line)?;
    let blanks = line[prefix..].len() - line[prefix..].trim_start_matches([' ', '\t']).len();
    if blanks == 0 {
        return None;
    }
    let group_end = prefix + blanks;
    let mut tail = line[group_end..].chars();
    let boxed = tail.next() == Some('[')
        && matches!(tail.next(), Some(' ' | 'x' | 'X'))
        && tail.next() == Some(']');
    boxed.then_some((group_end, group_end + 3))
}

/// `^[ \t]*(?:[-*+]|\d+[.)])`: the byte length of the marker with its indent.
fn list_marker(line: &str) -> Option<usize> {
    let rest = line.trim_start_matches([' ', '\t']);
    let indent = line.len() - rest.len();
    if rest.starts_with(['-', '*', '+']) {
        return Some(indent + 1);
    }
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    (digits > 0 && rest[digits..].starts_with(['.', ')'])).then_some(indent + digits + 1)
}

/// `LIST_ITEM_START`, `/^[ \t]*(?:[-*+]|\d+[.)])[ \t]/`.
fn list_item_start(line: &str) -> bool {
    list_marker(line).is_some_and(|end| line[end..].starts_with([' ', '\t']))
}

/// `BLOCK_START`: a line that opens a block of its own rather than continuing
/// a paragraph.
fn block_start(line: &str) -> bool {
    let rest = line.trim_start_matches([' ', '\t']);
    if list_item_start(line)
        || rest.starts_with(['>', '|'])
        || rest.starts_with("```")
        || rest.starts_with("~~~")
    {
        return true;
    }
    let hashes = rest.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes)
        && rest[hashes..]
            .chars()
            .next()
            .is_none_or(|c| matches!(c, ' ' | '\t'))
    {
        return true;
    }
    // `(?:[-*_=][ \t]*){3,}$`
    rest.starts_with(['-', '*', '_', '='])
        && rest
            .chars()
            .all(|c| matches!(c, '-' | '*' | '_' | '=' | ' ' | '\t'))
        && rest.chars().filter(|c| !matches!(c, ' ' | '\t')).count() >= 3
}

/// `endsInsideLinkText`: when `line` ends inside link text that the last
/// line of its paragraph closes, how many of `after`'s lines that paragraph
/// holds. An image, a code span, an escaped bracket, a link title, an address
/// the writer cannot spell back ([`address_keeps_split`]), a tag other than
/// `<br>`, a `<br>` against a line end or a hard break on a later line keeps
/// the old split. `depth` is how many `[` the line leaves open.
fn ends_inside_link_text(depth: usize, line: &str, after: &[String]) -> Option<usize> {
    // The depth test only reads `line`, and the rest only refuses, so asking it
    // first keeps a long lazy paragraph from being scanned per line.
    if depth == 0 {
        return None;
    }
    let line = seen(line);
    let end = after
        .iter()
        .position(|next| is_blank(next) || block_start(next));
    let rest = &after[..end.unwrap_or(after.len())];
    let last = rest.last()?;
    if !last.contains("](") {
        return None;
    }
    let paragraph = std::iter::once(line.as_str())
        .chain(rest.iter().map(String::as_str))
        .map(seen)
        .collect::<Vec<_>>()
        .join("\n");
    let rest_text = rest
        .iter()
        .map(|next| seen(next))
        .collect::<Vec<_>>()
        .join("\n");
    let refused = blocks_link_join(&paragraph)
        || address_keeps_split(&paragraph)
        || rest_text.to_ascii_lowercase().contains("<br")
        || rest[..rest.len() - 1]
            .iter()
            .any(|next| hard_break_spelling(next).is_some());
    (!refused).then_some(rest.len())
}

/// `/<br>/i` at the start of `chars`.
fn is_br_tag(chars: &[char]) -> bool {
    chars.len() >= 4
        && chars[0] == '<'
        && chars[1].eq_ignore_ascii_case(&'b')
        && chars[2].eq_ignore_ascii_case(&'r')
        && chars[3] == '>'
}

/// `/`|<(?!br>)|!\[|\\[[\]]|<br>[^\S\n]*\n|\n[^\S\n]*<br>/i` on a paragraph.
fn blocks_link_join(paragraph: &str) -> bool {
    let chars: Vec<char> = paragraph.chars().collect();
    let skip_blanks = |from: usize| {
        from + chars[from..]
            .iter()
            .take_while(|c| is_inline_space(**c))
            .count()
    };
    chars.iter().enumerate().any(|(i, c)| match c {
        '`' => true,
        '<' if !is_br_tag(&chars[i..]) => true,
        '<' => chars.get(skip_blanks(i + 4)) == Some(&'\n'),
        '!' => chars.get(i + 1) == Some(&'['),
        '\\' => matches!(chars.get(i + 1), Some('[' | ']')),
        '\n' => is_br_tag(&chars[skip_blanks(i + 1)..]),
        _ => false,
    })
}

/// `addressKeepsSplit`: true when an address in `paragraph` holds a title or a
/// space, or holds a parenthesis that is unbalanced or next to a backslash,
/// which the writer escapes again on every save (BBF-107).
fn address_keeps_split(paragraph: &str) -> bool {
    for (open, _) in paragraph.match_indices("](") {
        let mut depth = 0i64;
        let (mut paren, mut backslash, mut closed) = (false, false, false);
        for c in paragraph[open + 2..].chars() {
            if is_js_whitespace(c) {
                return true;
            }
            match c {
                '\\' => backslash = true,
                '(' => {
                    paren = true;
                    depth += 1;
                }
                ')' => {
                    depth -= 1;
                    if depth < 0 {
                        closed = true;
                        break;
                    }
                }
                _ => {}
            }
        }
        if paren && (!closed || backslash) {
            return true;
        }
    }
    false
}

/// The token's `MEMRYHBK<digits>;` at the start of `text`: its length and index.
fn token_at(text: &str) -> Option<(usize, &str)> {
    let after = text.strip_prefix(token_prefix())?;
    let digits = after.chars().take_while(char::is_ascii_digit).count();
    (digits > 0 && after[digits..].starts_with(';'))
        .then(|| (token_prefix().len() + digits + 1, &after[..digits]))
}

/// `unmaskHardBreaks`: a token followed by a newline becomes two newlines, and
/// the blanks before it are part of the break's spelling and go. A token that
/// lost its newline is deleted and the blanks stay.
pub(super) fn unmask_hard_breaks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut done = 0;
    let mut search = 0;
    while let Some(found) = text[search..].find(token_prefix()) {
        let start = search + found;
        let Some((length, _)) = token_at(&text[start..]) else {
            search = start + token_prefix().len();
            continue;
        };
        let blanks_start = text[done..start].trim_end_matches(is_inline_space).len() + done;
        out.push_str(&text[done..blanks_start]);
        let end = start + length;
        if text[end..].starts_with('\n') {
            out.push_str("\n\n");
            done = end + 1;
        } else {
            out.push_str(&text[blanks_start..start]);
            done = end;
        }
        search = done;
    }
    out.push_str(&text[done..]);
    out
}

/// `restoreHardBreakSpelling`: every token back to the spelling it replaced,
/// or deleted when none was recorded.
pub(super) fn restore_hard_break_spelling(text: &str, breaks: &[String]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(token_prefix()) {
        let Some((length, index)) = token_at(&rest[start..]) else {
            out.push_str(&rest[..start + token_prefix().len()]);
            rest = &rest[start + token_prefix().len()..];
            continue;
        };
        out.push_str(&rest[..start]);
        if let Some(spelling) = index.parse::<usize>().ok().and_then(|n| breaks.get(n)) {
            out.push_str(spelling);
        }
        rest = &rest[start + length..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A token as the tests below spell it, with the process's mask word in.
    fn salt(text: &str) -> String {
        text.replace("MEMRYHBK", token_prefix())
    }

    /// The masked text with the mask word taken out of its tokens.
    fn masked(markdown: &str) -> String {
        mask_hard_breaks(markdown)
            .0
            .replace(JOIN, "<br>")
            .replace(mask_word(), "")
    }

    #[test]
    fn a_hard_break_spelling_round_trips_through_its_token() {
        let (masked, breaks) = mask_hard_breaks("a  \nb\\\nc  \n\nd");
        assert_eq!(
            masked.replace(mask_word(), ""),
            "aMEMRYHBK0;\nbMEMRYHBK1;\nc  \n\nd"
        );
        assert_eq!(breaks, vec!["  ".to_owned(), "\\".to_owned()]);
        assert_eq!(unmask_hard_breaks(&salt("aMEMRYHBK0;\nb")), "a\n\nb");
        assert_eq!(
            restore_hard_break_spelling(&masked, &breaks),
            "a  \nb\\\nc  \n\nd"
        );
    }

    #[test]
    fn the_blanks_before_a_token_are_its_spelling_only_while_it_keeps_its_newline() {
        assert_eq!(unmask_hard_breaks(&salt("a \tMEMRYHBK0;\nb")), "a\n\nb");
        assert_eq!(unmask_hard_breaks(&salt("a  MEMRYHBK0;b")), "a  b");
        assert_eq!(unmask_hard_breaks(&salt("a MEMRYHBK0;")), "a ");
        assert_eq!(unmask_hard_breaks(&salt("a\n MEMRYHBK0;\nb")), "a\n\n\nb");
    }

    #[test]
    fn a_token_without_a_recorded_spelling_is_deleted() {
        assert_eq!(
            restore_hard_break_spelling(&salt("one MEMRYHBK9; two"), &[]),
            "one  two"
        );
    }

    #[test]
    fn a_list_item_continuation_joins_so_the_break_survives() {
        assert_eq!(masked("- a  \nb"), "- aMEMRYHBK0;<br>b");
        assert_eq!(
            masked("- a  \n  b  \nc"),
            "- aMEMRYHBK0;<br>bMEMRYHBK1;<br>c"
        );
        assert_eq!(masked("a  \nb"), "aMEMRYHBK0;\nb");
        assert_eq!(masked("- a  \n- b"), "- aMEMRYHBK0;\n- b");
    }

    #[test]
    fn a_list_item_whose_link_text_spans_lines_joins_without_a_token() {
        assert_eq!(masked("- [a\nb](u)"), "- [a<br>b](u)");
        assert_eq!(masked("- [ ] [a\nb](u)"), "- [ ] [a<br>b](u)");
    }

    #[test]
    fn a_list_item_join_is_never_carried_across_a_code_span_link_or_tag() {
        for markdown in ["- `a  \n  b` x", "- [a  \n  b](u)", "- a  \n  b <br> c"] {
            let second = markdown.split('\n').nth(1).unwrap().trim_start();
            assert!(
                !masked(markdown).contains(&format!("<br>{second}")),
                "{markdown}"
            );
        }
        assert!(!masked("- [a\n![i](u)](v)").contains("<br>"));
        assert!(!masked("- [a\nb](u \"t\")").contains("<br>"));
    }

    #[test]
    fn a_table_row_ending_in_a_backslash_or_spaces_is_not_a_break() {
        assert_eq!(masked("| a \\\n|---|\n| b |"), "| a \\\n|---|\n| b |");
        assert_eq!(
            masked("| a |\n|---|\n| b \\\n| c |"),
            "| a |\n|---|\n| b \\\n| c |"
        );
        assert_eq!(masked("| a  \n|---|\n| b |"), "| a  \n|---|\n| b |");
        // The table ends at a line without a pipe.
        assert_eq!(
            masked("| a |\n|---|\nx\\\ny"),
            "| a |\n|---|\nxMEMRYHBK0;\ny"
        );
        // A pipe line with no delimiter row below it is a paragraph.
        assert_eq!(masked("a | b\\\nc"), "a | bMEMRYHBK0;\nc");
    }
}
