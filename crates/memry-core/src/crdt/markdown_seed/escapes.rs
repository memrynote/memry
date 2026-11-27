//! The backslashes desktop's markdown writer puts in text that would read
//! back as markup: `packages/editor-schema/src/inline/markdown-escapes.ts`
//! (`escapeMarkdownText`), run by `writeHtmlCommentTokens` before BlockNote
//! writes the blocks. A character is escaped only where the parser could read
//! it as markup, judged on the block as the writer spells it, so text that
//! holds none keeps its bytes.
//!
//! Ported for a paragraph or a heading. Link text holding a backtick is
//! [`Unsupported`]: desktop keeps a code span inside link text
//! (`codeSpanRanges`), which this port does not decide.

use super::Unsupported;
use super::items::Item;
use super::roundtrip::UNSERIALIZED;
use super::shapes::is_table_separator;
use crate::domain::journal_rules::is_js_whitespace;

/// `ESCAPABLE`: the characters the parser's `tryBackslashEscape` accepts
/// after a backslash.
const ESCAPABLE: &str = "\\`*_{}[]()#+-.!~|>";

/// Stands in for a node the writer spells with none of the characters below.
const NODE: char = '\u{FFFC}';

/// A text run's place in the block's spelling.
struct Segment {
    item: usize,
    at: usize,
    in_link: bool,
}

/// `Place`: a paragraph holds lines that open blocks of their own, a heading
/// is one line, so a break in it is written `<br>`.
#[derive(Clone, Copy)]
struct Place {
    line_block: bool,
    one_line: bool,
}

/// `items` of a paragraph (or, with `heading`, a heading) with the text that
/// would read back as markup escaped. Code spans and bare links are as they
/// were; a break in a heading becomes `<br>`.
pub(super) fn escape_items(items: Vec<Item>, heading: bool) -> Result<Vec<Item>, Unsupported> {
    let place = Place {
        line_block: !heading,
        one_line: heading,
    };
    // A break in a code run is spelled outside its backticks, where the
    // writer gives it no escape; the port does not decide it.
    if items
        .iter()
        .any(|item| item.is_code() && item.text.contains('\n'))
    {
        return Err(UNSERIALIZED);
    }
    let (spelling, delimiters, segments) = spell(&items);
    if segments
        .iter()
        .any(|segment| segment.in_link && items[segment.item].text.contains('`'))
    {
        return Err(UNSERIALIZED);
    }
    let forced = if place.line_block {
        line_openers(&spelling)
    } else {
        vec![false; spelling.len()]
    };
    let pairing = Pairing::new(&spelling);
    let mut items = items;
    for segment in &segments {
        let text = items[segment.item].text.clone();
        let mut out = String::with_capacity(text.len());
        for (offset, ch) in text.chars().enumerate() {
            let at = segment.at + offset;
            if ch == '\n' && place.line_block && unwritable_break(&spelling, &delimiters, at) {
                return Err(UNSERIALIZED);
            } else if ch == '\n' && place.one_line {
                out.push_str("<br>");
            } else if forced[at] || is_markup(&spelling, &pairing, at, segment.in_link) {
                out.push('\\');
                out.push(ch);
            } else {
                out.push(ch);
            }
        }
        items[segment.item].text = out;
    }
    // The parser strips one space off each end of a code span that has one at
    // both, so ` b ` is written with a second.
    for item in items.iter_mut().filter(|item| item.is_code()) {
        let spaced = item.text.len() >= 2 && item.text.starts_with(' ') && item.text.ends_with(' ');
        if spaced && item.text.chars().any(|c| c != ' ') {
            item.text = format!(" {} ", item.text);
        }
    }
    Ok(items)
}

/// `spell`: the block as the writer spells it, near enough to tell markup,
/// which of its characters are a mark's delimiters, and where each escapable
/// text run starts.
fn spell(items: &[Item]) -> (Vec<char>, Vec<bool>, Vec<Segment>) {
    let mut spelling = Vec::new();
    let mut delimiters = Vec::new();
    let mut segments = Vec::new();
    // `delimiters` flags, per character of `spelling`, a mark's `**`, `*` or `~~`.
    let flag = |spelling: &[char], delimiters: &mut Vec<bool>, on: bool| {
        delimiters.resize(spelling.len(), on);
    };
    for (index, item) in items.iter().enumerate() {
        let marks = &item.marks;
        if item.is_code() {
            spelling.extend(['`', NODE, '`']);
            flag(&spelling, &mut delimiters, false);
        } else if let Some(href) = &marks.link {
            spelling.push('[');
            segments.push(Segment {
                item: index,
                at: spelling.len(),
                in_link: true,
            });
            spelling.extend(item.text.chars());
            spelling.extend([']', '(']);
            spelling.extend(href.chars());
            spelling.push(')');
            flag(&spelling, &mut delimiters, false);
        } else {
            let delimiter = if marks.bold {
                "**"
            } else if marks.italic {
                "*"
            } else if marks.strike {
                "~~"
            } else {
                ""
            };
            spelling.extend(delimiter.chars());
            flag(&spelling, &mut delimiters, true);
            segments.push(Segment {
                item: index,
                at: spelling.len(),
                in_link: false,
            });
            spelling.extend(item.text.chars());
            flag(&spelling, &mut delimiters, false);
            spelling.extend(delimiter.chars());
            flag(&spelling, &mut delimiters, true);
        }
    }
    (spelling, delimiters, segments)
}

fn is_space(c: Option<char>) -> bool {
    c.is_none_or(|c| c == ' ' || c == '\t')
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `flanks`: whether the `*` or `_` at `at` could open, and could close, a
/// span (`parseDelimited`).
fn flanks(spelling: &[char], at: usize) -> (bool, bool) {
    let prev = at.checked_sub(1).map(|i| spelling[i]);
    let next = spelling.get(at + 1).copied();
    let intraword = spelling[at] == '_' && is_word(prev) && is_word(next);
    (!is_space(next) && !intraword, at > 0 && !is_space(prev))
}

/// `pairs`, for every `*` and `_` of the spelling at once: whether the
/// character has a partner it could pair with, an opener after a closer or a
/// closer after an opener of the same character.
struct Pairing {
    paired: Vec<bool>,
}

impl Pairing {
    fn new(spelling: &[char]) -> Self {
        let mut paired = vec![false; spelling.len()];
        for delimiter in ['*', '_'] {
            let at: Vec<usize> = (0..spelling.len())
                .filter(|&i| spelling[i] == delimiter)
                .collect();
            let flank: Vec<(bool, bool)> = at.iter().map(|&i| flanks(spelling, i)).collect();
            let mut opener_before = false;
            for (n, &i) in at.iter().enumerate() {
                paired[i] = flank[n].1 && opener_before;
                opener_before |= flank[n].0;
            }
            let mut closer_after = false;
            for (n, &i) in at.iter().enumerate().rev() {
                paired[i] |= flank[n].0 && closer_after;
                closer_after |= flank[n].1;
            }
        }
        Self { paired }
    }
}

/// `isMarkup`: whether the character at `at` would be read as markup.
fn is_markup(spelling: &[char], pairing: &Pairing, at: usize, in_link: bool) -> bool {
    let next = spelling.get(at + 1).copied();
    match spelling[at] {
        '\\' => next.is_none_or(|c| c == '\n' || ESCAPABLE.contains(c)),
        '`' => spelling.iter().filter(|c| **c == '`').count() > 1,
        '*' | '_' => pairing.paired[at],
        '~' => (at > 0 && spelling[at - 1] == '~') || next == Some('~'),
        '[' => in_link,
        ']' => in_link || (next == Some('(') && spelling[..at].contains(&'[')),
        '!' => next == Some('['),
        _ => false,
    }
}

/// `lineOpeners`: the offsets in `spelling` of the characters that open a
/// block at a line start.
fn line_openers(spelling: &[char]) -> Vec<bool> {
    let mut out = vec![false; spelling.len()];
    let mut start = 0;
    loop {
        let end = spelling[start..]
            .iter()
            .position(|c| *c == '\n')
            .map_or(spelling.len(), |n| start + n);
        if let Some(offset) = block_opener(&spelling[start..end], start > 0) {
            out[start + offset] = true;
        }
        if end == spelling.len() {
            return out;
        }
        start = end + 1;
    }
}

/// `blockOpener`: the offset in `line` of a character that opens a block at a
/// line start (`continuation`: not the block's first line).
fn block_opener(line: &[char], continuation: bool) -> Option<usize> {
    let first_ink = line.iter().position(|c| !is_js_whitespace(*c));
    let blank = |c: Option<&char>| c.is_none_or(|c| is_js_whitespace(*c));
    let hashes = line.iter().take_while(|c| **c == '#').count();
    let dashes = line.iter().take_while(|c| **c == '-').count();
    let tab_or_space = |c: &char| matches!(c, ' ' | '\t');
    if ((1..=6).contains(&hashes) && blank(line.get(hashes)))
        || (dashes > 0 && line[dashes..].iter().all(tab_or_space))
    {
        return Some(0);
    }
    if is_thematic_break(line) {
        return first_ink;
    }
    // `^\s{0,3}>|^\s*[-+*](\s|$)`
    if let Some(ink) = first_ink {
        let bullet = matches!(line[ink], '-' | '+' | '*') && blank(line.get(ink + 1));
        if (line[ink] == '>' && ink <= 3) || bullet {
            return Some(ink);
        }
    }
    if line.first() == Some(&'[')
        && let Some(close) = line.iter().position(|c| *c == ']')
        && line.get(close + 1) == Some(&':')
    {
        return Some(0);
    }
    if line.contains(&'|') && is_table_separator(&line.iter().collect::<String>()) {
        return line.iter().position(|c| *c == '|');
    }
    if continuation && is_table_row(line) {
        return line.iter().position(|c| *c == '|');
    }
    // `^\s*\d+[.)](\s|$)`
    let indent = line.iter().take_while(|c| is_js_whitespace(**c)).count();
    let digits = line[indent..]
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .count();
    let marker = indent + digits;
    (digits > 0 && matches!(line.get(marker), Some('.' | ')')) && blank(line.get(marker + 1)))
        .then_some(marker)
}

/// `/^\s*\|(.+\|)+\s*$/`: a pipe, then at least one character and a pipe
/// that ends the line.
fn is_table_row(line: &[char]) -> bool {
    let start = line.iter().take_while(|c| is_js_whitespace(**c)).count();
    let end = line.len()
        - line
            .iter()
            .rev()
            .take_while(|c| is_js_whitespace(**c))
            .count();
    end >= start + 3 && line[start] == '|' && line[end - 1] == '|'
}

/// `unwritableBreak`: whether the newline at `at` sits where the writer has no
/// spelling for it: at the block's start or end, or in a run of three or more.
/// A mark's delimiters do not count, since the writer moves them past the
/// break. Desktop writes those as `<br>` or leaves them to the writer's trim,
/// and has changed which more than once, so a paragraph holding one is not
/// decided.
fn unwritable_break(spelling: &[char], delimiters: &[bool], at: usize) -> bool {
    let passes = |i: usize| spelling[i] == '\n' || delimiters[i];
    let mut start = at;
    while start > 0 && passes(start - 1) {
        start -= 1;
    }
    let mut end = at + 1;
    while end < spelling.len() && passes(end) {
        end += 1;
    }
    let run = spelling[start..end].iter().filter(|c| **c == '\n').count();
    start == 0 || end == spelling.len() || run >= 3
}

/// `/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/`.
fn is_thematic_break(line: &[char]) -> bool {
    let indent = line.iter().take_while(|c| **c == ' ').count();
    let Some(&mark) = line.get(indent).filter(|_| indent <= 3) else {
        return false;
    };
    if !matches!(mark, '-' | '*' | '_') {
        return false;
    }
    let rest = &line[indent..];
    rest.iter().all(|c| *c == mark || matches!(c, ' ' | '\t'))
        && rest.iter().filter(|c| **c == mark).count() >= 3
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crdt::markdown_seed::SeedMarks;

    fn plain(text: &str) -> Item {
        Item {
            text: text.to_owned(),
            marks: SeedMarks::default(),
        }
    }

    fn escaped(text: &str) -> String {
        let items = escape_items(vec![plain(text)], false).expect("escaped");
        items.into_iter().map(|item| item.text).collect()
    }

    #[test]
    fn markup_that_pairs_is_escaped() {
        assert_eq!(escaped("a *b* c"), "a \\*b\\* c");
        assert_eq!(escaped("a `b` c"), "a \\`b\\` c");
        assert_eq!(escaped("a _b_ c"), "a \\_b\\_ c");
        assert_eq!(escaped("a ~~b~~ c"), "a \\~\\~b\\~\\~ c");
        assert_eq!(escaped("a\\*"), "a\\\\*");
    }

    #[test]
    fn text_that_pairs_nothing_keeps_its_bytes() {
        assert_eq!(escaped("5 * 3"), "5 * 3");
        assert_eq!(escaped("a_b_c"), "a_b_c");
        assert_eq!(escaped("[[_draft]]"), "[[_draft]]");
        assert_eq!(escaped("a ! b ~ c ] d"), "a ! b ~ c ] d");
        assert_eq!(escaped("a\\b"), "a\\b");
        assert_eq!(escaped("a\\"), "a\\\\");
    }

    #[test]
    fn a_line_opener_is_escaped_at_a_line_start() {
        assert_eq!(escaped("# x"), "\\# x");
        assert_eq!(escaped("1. y"), "1\\. y");
        assert_eq!(escaped("> q"), "\\> q");
        assert_eq!(escaped("- l"), "\\- l");
        assert_eq!(escaped("a\n# x"), "a\n\\# x");
        assert_eq!(escaped("---"), "\\---");
        assert_eq!(escaped("***"), "\\*\\*\\*");
        assert_eq!(escaped("a # x"), "a # x");
        assert_eq!(escaped("  - l"), "  \\- l");
        assert_eq!(escaped("12. y"), "12\\. y");
        assert_eq!(escaped("a\n| b |"), "a\n\\| b |");
        assert_eq!(escaped("| b |"), "| b |");
    }

    #[test]
    fn a_break_the_writer_cannot_spell_is_not_decided() {
        assert!(escape_items(vec![plain("\na")], false).is_err());
        assert!(escape_items(vec![plain("a\n")], false).is_err());
        assert!(escape_items(vec![plain("a\n\n\nb")], false).is_err());
        assert_eq!(escaped("a\n\nb"), "a\n\nb");
        let heading = escape_items(vec![plain("a\nb")], true).expect("escaped");
        assert_eq!(heading[0].text, "a<br>b");
    }
}
