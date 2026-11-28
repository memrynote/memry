//! Raw HTML the editor does not handle, kept as the text the author wrote:
//! `packages/editor-schema/src/inline/raw-html.ts` (`maskRawHtml`), which says
//! why (chapter 12 §12.1.0 states the rule).
//!
//! Every `<` that opens a construct the editor has no node for is hidden from
//! the parse and put back as text. A tag, declaration, CDATA section or
//! processing instruction that closes on its own line within [`BOUND`] UTF-16
//! units is one token holding all of it; any other candidate (a tag that closes
//! on a later line, `<div` with no `>`, one past the bound, one with a `|` in
//! it) hides only its `<`. The tags the editor does handle are left alone, and
//! so is a `<` inside code or opening a link's address. The token is
//! `;MEMRYRAW<word><n>;`, bounded by characters that are no markup, so
//! emphasis next to a tag reads as it did with the angle brackets there.
//!
//! A tag left alone still sends its block to the fallback
//! ([`fallback`]): this port builds no mark for it.

use std::borrow::Cow;
use std::sync::LazyLock;

use super::handled::{Nesting, is_handled, names_handled_tag};
use super::html_tag::{Closers, Line, is_blank, opens_construct, read_construct};
use super::markers::FenceTracker;
use super::mask_word::mask_word;
use super::mentions;
use super::{SeedBlock, SeedInline, SeedKind};

/// The characters `tryBackslashEscape` takes after a backslash.
const ESCAPABLE: &str = "\\`*_{}[]()#+-.!~|>";

/// `;MEMRYRAW` and the process's mask word: no source text spells a token.
fn token_prefix() -> &'static str {
    static PREFIX: LazyLock<String> = LazyLock::new(|| format!(";MEMRYRAW{}", mask_word()));
    &PREFIX
}

/// `[start, end)` of a hidden range, in characters of the scanned text: one
/// character for a lone `<`.
pub(super) type Span = (usize, usize);

/// Where the first non-blank character after a link's `](` is.
fn address_start(line: &Line, close: usize) -> Option<usize> {
    if line.get(close + 1) != Some('(') {
        return None;
    }
    let mut at = close + 2;
    while is_blank(line.get(at)) {
        at += 1;
    }
    Some(at)
}

/// Where to read on after the backtick run at `at`: past the span it opens when
/// a run of the same length closes it on this line, else past the run.
fn code_span_end(chars: &[char], at: usize) -> usize {
    let mut run = at;
    while chars.get(run) == Some(&'`') {
        run += 1;
    }
    let length = run - at;
    let mut from = run;
    while let Some(tick) = chars[from.min(chars.len())..]
        .iter()
        .position(|&c| c == '`')
    {
        let tick = from + tick;
        let mut end = tick;
        while chars.get(end) == Some(&'`') {
            end += 1;
        }
        if end - tick == length {
            return end;
        }
        from = end;
    }
    run
}

fn scan_line(
    chars: &[char],
    base: usize,
    markdown: bool,
    nesting: &mut Nesting,
    spans: &mut Vec<Span>,
) {
    let line = Line::new(chars);
    let n = chars.len();
    // The `[` this line has left open, and where the address of the last link
    // starts: `[a](<x y>)` is a destination the link mask reads.
    let mut depth = 0usize;
    let mut address: Option<usize> = None;
    let mut closers = Closers::new();
    let mut at = 0;
    while at < n {
        let ch = chars[at];
        if ch == '<' {
            if opens_construct(&line, at) && address != Some(at) {
                match read_construct(&line, at, &mut closers) {
                    None => {
                        let within = names_handled_tag(&line, at)
                            .is_some_and(|(name, closing)| nesting.within(&name, closing));
                        if !within {
                            spans.push((base + at, base + at + 1));
                        }
                    }
                    Some(found) => {
                        if let Some(tag) = &found.tag
                            && is_handled(tag, nesting)
                        {
                            at = found.end;
                            continue;
                        }
                        // A row splits at a pipe before it reads a tag.
                        if chars[at..found.end].contains(&'|') {
                            spans.push((base + at, base + at + 1));
                        } else {
                            spans.push((base + at, base + found.end));
                            at = found.end;
                            continue;
                        }
                    }
                }
            }
        } else if markdown {
            match ch {
                '\\' => {
                    if at + 1 < n && ESCAPABLE.contains(chars[at + 1]) {
                        at += 1;
                    }
                }
                '`' => {
                    at = code_span_end(chars, at);
                    continue;
                }
                '[' => depth += 1,
                ']' if depth > 0 => {
                    depth -= 1;
                    address = address_start(&line, at);
                }
                _ => {}
            }
        }
        at += 1;
    }
}

/// The hidden ranges of `text`, in order. In `markdown` mode `text` is a note
/// and its fences, code spans, backslash escapes and link addresses are read;
/// in text mode it is the characters of a text run, which the writer spells.
pub(super) fn scan(text: &str, markdown: bool) -> Vec<Span> {
    let mut spans = Vec::new();
    if !text.contains('<') {
        return spans;
    }
    let mut nesting = Nesting::default();
    let mut fence = FenceTracker::default();
    let mut base = 0;
    for line in text.split('\n') {
        let chars: Vec<char> = line.chars().collect();
        let in_fence = markdown && fence.consume(line);
        if !in_fence && line.contains('<') {
            scan_line(&chars, base, markdown, &mut nesting, &mut spans);
        }
        base += chars.len() + 1;
    }
    spans
}

/// Why a line holding raw HTML sends its block to the fallback, or `None`: a
/// `<` outside code, followed by a letter, `/`, `!` or `?`. Read on the line
/// with the raw HTML the editor does not handle hidden, so what is left is a
/// tag it handles, which this seed builds no mark for.
pub(super) fn fallback(line: &str) -> Option<&'static str> {
    let chars: Vec<char> = line.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        match chars[at] {
            '\\' if at + 1 < chars.len() && ESCAPABLE.contains(chars[at + 1]) => at += 1,
            '`' => {
                at = code_span_end(&chars, at);
                continue;
            }
            '<' if chars
                .get(at + 1)
                .is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, '/' | '!' | '?')) =>
            {
                return Some("HTML");
            }
            _ => {}
        }
        at += 1;
    }
    None
}

/// The tags `text` spells whole, which the writer must leave as they are.
pub(super) fn spelled_tags(text: &str) -> Vec<Span> {
    scan(text, false)
        .into_iter()
        .filter(|(start, end)| end - start > 1)
        .collect()
}

/// `maskRawHtml`: `markdown` with every `<` that opens raw HTML the editor
/// does not handle hidden, and what each token replaced.
pub(super) fn mask(markdown: &str) -> (String, Vec<String>) {
    let spans = scan(markdown, true);
    if spans.is_empty() {
        return (markdown.to_owned(), Vec::new());
    }
    let chars: Vec<char> = markdown.chars().collect();
    let mut sources = Vec::with_capacity(spans.len());
    let mut out = String::with_capacity(markdown.len());
    let mut last = 0;
    for (start, end) in spans {
        out.extend(&chars[last..start]);
        out.push_str(&format!("{}{};", token_prefix(), sources.len()));
        sources.push(chars[start..end].iter().collect());
        last = end;
    }
    out.extend(&chars[last..]);
    (out, sources)
}

/// `restoreRawHtml`: `text` with the tokens [`mask`] made turned back into
/// their characters. A token no source matches is left as it is.
fn restore<'a>(text: &'a str, sources: &[String]) -> Cow<'a, str> {
    let prefix = token_prefix();
    if sources.is_empty() || !text.contains(prefix) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(prefix) {
        out.push_str(&rest[..at]);
        let after = &rest[at + prefix.len()..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        let source = after[digits..]
            .starts_with(';')
            .then(|| after[..digits].parse::<usize>().ok())
            .flatten()
            .and_then(|index| sources.get(index));
        match source {
            Some(source) => {
                out.push_str(source);
                rest = &after[digits + 1..];
            }
            None => {
                out.push_str(&rest[at..at + prefix.len()]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// Whether a token was put back in `text`.
fn restore_in(text: &mut String, sources: &[String]) -> bool {
    match restore(text, sources) {
        Cow::Owned(restored) => {
            *text = restored;
            true
        }
        Cow::Borrowed(_) => false,
    }
}

fn restore_inline(content: &mut [SeedInline], sources: &[String]) {
    for piece in content {
        match piece {
            SeedInline::Text { text, marks } => {
                // A hidden tag holds the placeholders of the `((…))` tokens it
                // held, which a run puts back after it, as desktop's
                // `repairRuns` does; an address or a name does not.
                if restore_in(text, sources) {
                    *text = mentions::restore(text);
                }
                if let Some(link) = &mut marks.link {
                    restore_in(link, sources);
                }
            }
            SeedInline::HardBreak { marks } => {
                if let Some(link) = &mut marks.link {
                    restore_in(link, sources);
                }
            }
            SeedInline::HtmlComment { source } => {
                restore_in(source, sources);
            }
            SeedInline::InlineImage { src, alt, .. } => {
                restore_in(src, sources);
                restore_in(alt, sources);
            }
            // Made by the promotion, which runs after every chunk.
            SeedInline::Token(_) => {}
        }
    }
}

/// [`restore`] over every string a parsed block holds: its runs and their
/// links, a table's cells, a code block's language, an image's address and
/// name, and its children.
pub(super) fn restore_blocks(blocks: &mut [SeedBlock], sources: &[String]) {
    if sources.is_empty() {
        return;
    }
    for block in blocks {
        match &mut block.kind {
            SeedKind::CodeBlock { language } => {
                restore_in(language, sources);
            }
            SeedKind::Image { url, name, .. } | SeedKind::Video { url, name } => {
                restore_in(url, sources);
                restore_in(name, sources);
            }
            SeedKind::Table { rows } => {
                for cell in rows.iter_mut().flat_map(|row| row.cells.iter_mut()) {
                    restore_inline(&mut cell.content, sources);
                }
            }
            _ => {}
        }
        restore_inline(&mut block.content, sources);
        restore_blocks(&mut block.children, sources);
    }
}

#[cfg(test)]
mod tests {
    use super::super::html_tag::BOUND;
    use super::super::nesting::MAX_NESTING;
    use super::*;

    /// The source of each range the scan hides in `markdown`.
    fn hidden(markdown: &str) -> Vec<String> {
        let chars: Vec<char> = markdown.chars().collect();
        scan(markdown, true)
            .into_iter()
            .map(|(start, end)| chars[start..end].iter().collect())
            .collect()
    }

    #[test]
    fn each_whole_tag_the_editor_does_not_handle_is_hidden() {
        for (markdown, expected) in [
            ("<kbd>Ctrl</kbd>", vec!["<kbd>", "</kbd>"]),
            ("<KBD>", vec!["<KBD>"]),
            (
                "<kq a=\"1 2\" b='3' c=4 d>",
                vec!["<kq a=\"1 2\" b='3' c=4 d>"],
            ),
            ("<kq/> <kq />", vec!["<kq/>", "<kq />"]),
            (
                "<!x> <?x?> <![CDATA[x]]>",
                vec!["<!x>", "<?x?>", "<![CDATA[x]]>"],
            ),
            ("<script>kq9</script>", vec!["<script>", "</script>"]),
            ("<input type=text>", vec!["<input type=text>"]),
            ("<x a=\"*b*\">", vec!["<x a=\"*b*\">"]),
            ("\\<kq>", vec!["<kq>"]),
            ("<x a=\"<kbd>\">", vec!["<x a=\"<kbd>\">"]),
        ] {
            assert_eq!(hidden(markdown), expected, "{markdown:?}");
        }
    }

    #[test]
    fn a_tag_the_editor_handles_is_left_alone() {
        for tag in [
            "<b>",
            "</STRONG>",
            "<a href=\"u\">",
            "<br/>",
            "<img src=x>",
            "<span style=\"color:red\">x</span>",
            "<span STYLE>y</span>",
            "<details open data-memry-toggle>",
            "<input checked type=\"checkbox\">",
            "<input type=CHECKBOX>",
        ] {
            assert_eq!(hidden(&format!("a {tag} b")), Vec::<String>::new(), "{tag}");
        }
    }

    #[test]
    fn a_handled_tag_past_the_nesting_cap_is_hidden_with_its_closing_tag() {
        let cap = MAX_NESTING;
        let text = format!("{}x{}", "<b>".repeat(cap + 1), "</b>".repeat(cap + 1));
        let chars: Vec<char> = text.chars().collect();
        let spans = scan(&text, true);
        // The first closing tag closes the innermost open tag, the one the cap hid.
        assert_eq!(
            spans,
            [
                (cap * 3, cap * 3 + 3),
                ((cap + 1) * 3 + 1, (cap + 1) * 3 + 5)
            ]
        );
        assert_eq!(
            chars[spans[0].0..spans[0].1].iter().collect::<String>(),
            "<b>"
        );

        assert_eq!(
            hidden(&format!("{}x{}", "<b>".repeat(cap), "</b>".repeat(cap))),
            Vec::<String>::new()
        );
        assert_eq!(hidden(&"<b>x</b>".repeat(50 * cap)), Vec::<String>::new());
        assert_eq!(
            hidden(&"<b><i><u><s><code>\n".repeat(21)),
            ["<b>", "<i>", "<u>", "<s>", "<code>"]
        );
        let styled = format!(
            "{}x{}",
            "<span style=\"c\">".repeat(cap + 1),
            "</span>".repeat(cap + 1)
        );
        assert_eq!(hidden(&styled), ["<span style=\"c\">", "</span>"]);
        assert_eq!(hidden(&"<b\n".repeat(cap + 1)), ["<"]);
        assert_eq!(hidden(&format!("{}<b\n", "<b ".repeat(cap))), ["<"]);
        assert_eq!(hidden(&"<b/>".repeat(cap + 1)), ["<b/>"]);
        let empty = "<br><img src=a><hr><input type=checkbox><br/>".repeat(5 * cap);
        assert_eq!(hidden(&empty), Vec::<String>::new());
        assert_eq!(
            hidden(&format!("{}<b>", "</b>".repeat(5 * cap))),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_closing_span_belongs_to_the_innermost_open_span() {
        assert_eq!(hidden("<span>a</span>"), ["<span>", "</span>"]);
        assert_eq!(
            hidden("<span style=\"c\"><span>a</span></span>"),
            ["<span>", "</span>"]
        );
        assert_eq!(
            hidden("</span> <span style=\"c\">a</span> </span>"),
            ["</span>", "</span>"]
        );
        assert_eq!(hidden("<span/> </span>"), ["<span/>", "</span>"]);
        assert_eq!(hidden("<span>\nb\n</span>"), ["<span>", "</span>"]);
    }

    #[test]
    fn only_the_angle_bracket_of_a_tag_read_not_whole_is_hidden() {
        for markdown in [
            "<kq\nb>",
            "a <div",
            "a <?x",
            "a <![CDATA[x",
            "<kq a=>",
            "<kq a=\"x>",
            "<kq a=\"1\"b=\"2\">",
            "<!1>",
            "<span\nstyle=\"c\">",
            "<x a=\"|\">",
        ] {
            assert_eq!(hidden(markdown), ["<"], "{markdown:?}");
        }
        assert_eq!(hidden("<https://e.com> <a@b.co>"), ["<", "<"]);
        assert_eq!(hidden("| <x a=\"b\"> | <y> |"), ["<x a=\"b\">", "<y>"]);
    }

    #[test]
    fn a_lt_that_opens_no_construct_is_left_alone() {
        for markdown in [
            "< kq>",
            "<1>",
            "<>",
            "</>",
            "</ kq>",
            "<!-- c -->",
            "<!--",
            "a < b",
            "a<",
            "<<",
            "1 <= 2",
            "<-",
        ] {
            assert_eq!(hidden(markdown), Vec::<String>::new(), "{markdown:?}");
        }
    }

    #[test]
    fn a_lt_in_code_or_opening_a_link_address_is_not_a_tag() {
        for (markdown, expected) in [
            ("```\n<kbd>\n```", vec![]),
            ("~~~js\n<kbd>\n~~~\n<kbd>", vec!["<kbd>"]),
            ("`<kbd>` `` <x> `` <kbd>", vec!["<kbd>"]),
            ("[a](<x>) [b](  <y z>) ![c](<w>)", vec![]),
            ("[a](u<x>)", vec!["<x>"]),
            ("x](<kbd>)", vec!["<kbd>"]),
            ("\\[a\\](<kbd>)", vec!["<kbd>"]),
            ("[a [b](<x>) c](<y>)", vec![]),
            ("a ` <kbd>", vec!["<kbd>"]),
            ("a \\`<kbd>\\` b", vec!["<kbd>"]),
            ("<x a=\"`\"> `b`", vec!["<x a=\"`\">"]),
        ] {
            assert_eq!(hidden(markdown), expected, "{markdown:?}");
        }
    }

    #[test]
    fn a_tag_is_read_whole_only_within_the_bound_in_utf16_units() {
        let tag = |fill: usize| format!("<x a=\"{}\">", "y".repeat(fill));
        assert_eq!(hidden(&tag(BOUND - 9)), [tag(BOUND - 9)]);
        assert_eq!(hidden(&tag(BOUND - 8)), [tag(BOUND - 8)]);
        assert_eq!(hidden(&tag(BOUND - 7)), ["<"]);
        let emoji = |count: usize| format!("<x a=\"{}\">", "😀".repeat(count));
        assert_eq!(hidden(&emoji((BOUND - 8) / 2)), [emoji((BOUND - 8) / 2)]);
        assert_eq!(hidden(&emoji((BOUND - 8) / 2 + 1)), ["<"]);
    }

    #[test]
    fn a_long_line_of_unfinished_constructs_is_read_in_linear_time() {
        for markdown in [
            "<a ".repeat(200_000),
            "<x a=\"".repeat(100_000),
            "<?".repeat(200_000),
            "<![CDATA[".repeat(100_000),
            "`<x ".repeat(100_000),
        ] {
            let started = std::time::Instant::now();
            scan(&markdown, true);
            assert!(started.elapsed().as_secs() < 2);
        }
    }

    #[test]
    fn a_hidden_tag_comes_back_and_a_stray_token_stays() {
        let markdown = "a <kbd>Ctrl</kbd> and <x a=\"*b*\"> or <div and <script>kq9</script>";
        let (masked, sources) = mask(markdown);
        assert!(!masked.contains('<'));
        assert_eq!(sources.len(), 6);
        assert_eq!(restore(&masked, &sources), markdown);
        let stray = format!("{}99;", token_prefix());
        assert_eq!(restore(&stray, &sources), stray);
        assert_eq!(mask("plain <b>text</b>").1, Vec::<String>::new());
    }

    #[test]
    fn a_tag_in_code_does_not_send_its_line_to_the_fallback() {
        assert_eq!(fallback("kq0 `<kbd>` kq1"), None);
        assert_eq!(fallback("a \\<kq> `b`"), Some("HTML"));
        assert_eq!(fallback("a <b>x</b>"), Some("HTML"));
        assert_eq!(fallback("a <!-- c"), Some("HTML"));
    }
}
