//! Port of `packages/shared/src/markdown-code.ts`: one line-by-line pass that
//! hands fenced code, code spans and comments to a visitor.

use crate::markdown::frontmatter::js::js_trim;
use crate::markdown::shared::empty_lines::is_table_row_line;
use crate::markdown::shared::markdown_fences::FenceTracker;

/// What the pass does with each construct it recognises.
pub(crate) trait Visitor {
    /// A line of a fenced or indented code block.
    fn code_line(&mut self, line: &str) -> String;
    fn code_span(&mut self, source: &str) -> String;
    /// A comment opener that is text: it never closes, or is cut off by a fence or a cell.
    fn text_open(&mut self, open: &str) -> String;
    /// A whole comment, line breaks included. `closed` is false for an HTML
    /// comment still open at the end of the note.
    fn comment(
        &mut self,
        source: &str,
        closed: bool,
        whole_line: bool,
        block_goes_on: bool,
    ) -> String;
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn may_hold_code(markdown: &str) -> bool {
    markdown.contains('`')
        || markdown.contains("~~~")
        || line_starts(markdown).any(|at| is_indented(&markdown[at..]))
}

/// Offsets JS `^` with the `m` flag matches at.
fn line_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(text.char_indices().filter_map(|(at, c)| {
        matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}').then_some(at + c.len_utf8())
    }))
}

/// `INDENTED`: four columns of indent, a tab counting as the rest of its stop.
fn is_indented(line: &str) -> bool {
    let spaces = line.bytes().take_while(|b| *b == b' ').count();
    spaces >= 4 || (spaces <= 3 && line[spaces..].starts_with('\t'))
}

/// `blankMarkdownCode`: code blanked, comments kept.
pub fn blank_markdown_code(markdown: &str) -> String {
    struct Blank;
    impl Visitor for Blank {
        fn code_line(&mut self, _line: &str) -> String {
            String::new()
        }
        fn code_span(&mut self, _source: &str) -> String {
            " ".to_owned()
        }
        fn text_open(&mut self, open: &str) -> String {
            open.to_owned()
        }
        fn comment(&mut self, source: &str, _: bool, _: bool, _: bool) -> String {
            source.to_owned()
        }
    }
    if !may_hold_code(markdown) {
        return markdown.to_owned();
    }
    walk_markdown(markdown, &mut Blank)
}

/// `maskMarkdownCode`: code blanked to spaces of the same UTF-16 length.
pub fn mask_markdown_code(markdown: &str) -> String {
    struct Mask;
    impl Visitor for Mask {
        fn code_line(&mut self, line: &str) -> String {
            " ".repeat(utf16_len(line))
        }
        fn code_span(&mut self, source: &str) -> String {
            " ".repeat(utf16_len(source))
        }
        fn text_open(&mut self, open: &str) -> String {
            open.to_owned()
        }
        fn comment(&mut self, source: &str, _: bool, _: bool, _: bool) -> String {
            source.to_owned()
        }
    }
    if !may_hold_code(markdown) {
        return markdown.to_owned();
    }
    walk_markdown(markdown, &mut Mask)
}

/// `stripMarkdownComments`.
pub fn strip_markdown_comments(markdown: &str) -> String {
    replace_markdown_comments(markdown, &mut |_, _, _| String::new(), "<!--", "<!--")
}

/// `replaceMarkdownComments`: every closed comment outside code replaced by
/// `replace(source, whole_line, block_goes_on)`. A `<!--` read as text, or one
/// that never closes, becomes `text_open`, except one that never closes and
/// opens an HTML block, which becomes `unclosed_open`. The TypeScript default
/// for both is `<!--`.
pub fn replace_markdown_comments(
    markdown: &str,
    replace: &mut dyn FnMut(&str, bool, bool) -> String,
    text_open: &str,
    unclosed_open: &str,
) -> String {
    struct Replace<'a> {
        replace: &'a mut dyn FnMut(&str, bool, bool) -> String,
        text_open: &'a str,
        unclosed_open: &'a str,
    }
    impl Visitor for Replace<'_> {
        fn code_line(&mut self, line: &str) -> String {
            line.to_owned()
        }
        fn code_span(&mut self, source: &str) -> String {
            source.to_owned()
        }
        fn text_open(&mut self, open: &str) -> String {
            if open == "<!--" {
                self.text_open.to_owned()
            } else {
                open.to_owned()
            }
        }
        fn comment(
            &mut self,
            source: &str,
            closed: bool,
            whole_line: bool,
            block_goes_on: bool,
        ) -> String {
            if closed {
                (self.replace)(source, whole_line, block_goes_on)
            } else {
                let opener = if block_goes_on {
                    self.unclosed_open
                } else {
                    self.text_open
                };
                format!("{opener}{}", &source["<!--".len()..])
            }
        }
    }
    if !markdown.contains("<!--") && !markdown.contains("%%") {
        return markdown.to_owned();
    }
    walk_markdown(
        markdown,
        &mut Replace {
            replace,
            text_open,
            unclosed_open,
        },
    )
}

#[derive(Clone, Copy)]
struct CommentForm {
    open: &'static str,
    close: &'static str,
    prose_only: bool,
}

const COMMENT_FORMS: [CommentForm; 2] = [
    CommentForm {
        open: "<!--",
        close: "-->",
        prose_only: false,
    },
    CommentForm {
        open: "%%",
        close: "%%",
        prose_only: true,
    },
];

#[derive(Clone, Copy)]
struct CommentClose {
    line: usize,
    end: usize,
}

enum Later {
    Text,
    Close(CommentClose),
    Open,
}

struct Pending {
    prefix: String,
    source: String,
    close: Option<CommentClose>,
    html_block: bool,
    opens_block: bool,
}

/// `HTML_BLOCK_COMMENT`: `^(?: {0,3}(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)]) {1,4}(?! )))* {0,3}<!--`.
fn is_html_block_comment(line: &str) -> bool {
    fn from(bytes: &[u8], at: usize, failed: &mut Vec<bool>) -> bool {
        if failed[at] {
            return false;
        }
        let spaces = bytes[at..]
            .iter()
            .take_while(|b| **b == b' ')
            .count()
            .min(3);
        if bytes[at + spaces..].starts_with(b"<!--") {
            return true;
        }
        // One container marker after the indent, then the rest of the line.
        let mut p = at + spaces;
        let next = match bytes.get(p) {
            Some(b'>') => {
                p += 1;
                let mut ends = vec![p];
                if matches!(bytes.get(p), Some(b' ' | b'\t')) {
                    ends.push(p + 1);
                }
                ends
            }
            Some(b'-' | b'*' | b'+') => list_marker_end(bytes, p + 1).into_iter().collect(),
            Some(b'0'..=b'9') => {
                let digits = bytes[p..].iter().take_while(|b| b.is_ascii_digit()).count();
                if digits <= 9 && matches!(bytes.get(p + digits), Some(b'.' | b')')) {
                    list_marker_end(bytes, p + digits + 1).into_iter().collect()
                } else {
                    Vec::new()
                }
            }
            _ => Vec::new(),
        };
        for end in next {
            if from(bytes, end, failed) {
                return true;
            }
        }
        failed[at] = true;
        false
    }
    /// ` {1,4}(?! )` after a list marker ending at `at`.
    fn list_marker_end(bytes: &[u8], at: usize) -> Option<usize> {
        let run = bytes[at.min(bytes.len())..]
            .iter()
            .take_while(|b| **b == b' ')
            .count();
        (1..=4).contains(&run).then_some(at + run)
    }
    let bytes = line.as_bytes();
    from(bytes, 0, &mut vec![false; bytes.len() + 1])
}

/// `CONTAINER_START`: a list item or footnote definition opener.
fn is_container_start(line: &str) -> bool {
    let bytes = line.as_bytes();
    let spaces = bytes.iter().take_while(|b| **b == b' ').count().min(3);
    let rest = &line[spaces..];
    let after = match rest.as_bytes().first() {
        Some(b'-' | b'*' | b'+') => &rest[1..],
        Some(b'0'..=b'9') => {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            if digits > 9 || !matches!(rest.as_bytes().get(digits), Some(b'.' | b')')) {
                return false;
            }
            &rest[digits + 1..]
        }
        Some(b'[') if rest[1..].starts_with('^') => {
            let label = &rest[2..];
            let len = label
                .find(|c: char| c == ']' || crate::markdown::frontmatter::js::is_js_whitespace(c))
                .unwrap_or(label.len());
            if len == 0 || !label[len..].starts_with("]:") {
                return false;
            }
            &label[len + 2..]
        }
        _ => return false,
    };
    after.is_empty()
        || after
            .chars()
            .next()
            .is_some_and(crate::markdown::frontmatter::js::is_js_whitespace)
}

fn without_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// Start of the next backtick run exactly `length` long at or after `from`.
fn find_closing_run(line: &str, from: usize, length: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        let start = i + line[i..].find('`')?;
        let mut end = start;
        while bytes.get(end) == Some(&b'`') {
            end += 1;
        }
        if end - start == length {
            return Some(start);
        }
        i = end;
    }
    None
}

fn index_outside_code_spans(line: &str, marker: &str) -> Option<usize> {
    let mut i = 0;
    loop {
        let at = line[i..].find(marker).map(|n| i + n);
        let tick = line[i..].find('`').map(|n| i + n);
        let (Some(a), Some(tick)) = (at, tick) else {
            return at;
        };
        if a < tick {
            return at;
        }
        let mut run_end = tick;
        while line.as_bytes().get(run_end) == Some(&b'`') {
            run_end += 1;
        }
        i = match find_closing_run(line, run_end, run_end - tick) {
            Some(close) => close + (run_end - tick),
            None => run_end,
        };
    }
}

fn find_later_close(lines: &[&str], index: usize, form: CommentForm, inline: bool) -> Later {
    let mut fence = FenceTracker::new();
    for (next, line) in lines.iter().enumerate().skip(index + 1) {
        if fence.consume(without_cr(line)) {
            if form.prose_only {
                continue;
            }
            if inline {
                return Later::Text;
            }
        }
        let at = if form.prose_only {
            index_outside_code_spans(line, form.close)
        } else {
            line.find(form.close)
        };
        if let Some(at) = at {
            return Later::Close(CommentClose {
                line: next,
                end: at + form.close.len(),
            });
        }
    }
    Later::Open
}

fn next_comment_open(line: &str, from: usize) -> Option<(CommentForm, usize)> {
    let mut best: Option<(CommentForm, usize)> = None;
    for form in COMMENT_FORMS {
        if let Some(n) = line[from..].find(form.open) {
            let at = from + n;
            if best.is_none_or(|(_, b)| at < b) {
                best = Some((form, at));
            }
        }
    }
    best
}

/// The next unescaped `|` after `from` that ends a cell, or the line's length.
fn cell_pipe(line: &str, from: usize) -> usize {
    let bytes = line.as_bytes();
    let mut depth = 0;
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 1;
        } else if bytes[i..].starts_with(b"[[") {
            depth += 1;
            i += 1;
        } else if depth > 0 && bytes[i..].starts_with(b"]]") {
            depth -= 1;
            i += 1;
        } else if bytes[i] == b'|' && depth == 0 {
            return i;
        }
        i += 1;
    }
    bytes.len()
}

fn opens_html_block(html_block: bool, closes_comment: bool, i: usize, form: CommentForm) -> bool {
    html_block && !closes_comment && i == 0 && !form.prose_only
}

fn walk_markdown(markdown: &str, visit: &mut dyn Visitor) -> String {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut fence = FenceTracker::new();
    let mut out: Vec<String> = Vec::new();
    let mut pending: Option<Pending> = None;
    let mut block_start = true;
    let mut indented_code = false;
    let mut container = false;

    for (index, full_line) in lines.iter().enumerate() {
        let mut line: &str = full_line;
        let mut result = String::new();
        let mut closes_comment = false;
        let mut html_block = false;

        if let Some(p) = pending.as_mut() {
            let Some(close) = p.close.filter(|c| c.line == index) else {
                p.source.push('\n');
                p.source.push_str(line);
                if index == lines.len() - 1 {
                    out.push(format!(
                        "{}{}",
                        p.prefix,
                        visit.comment(&p.source, false, false, p.opens_block)
                    ));
                }
                continue;
            };
            let block_goes_on = p.opens_block && !js_trim(&line[close.end..]).is_empty();
            let source = format!("{}\n{}", p.source, &line[..close.end]);
            result = format!(
                "{}{}",
                p.prefix,
                visit.comment(&source, true, false, block_goes_on)
            );
            html_block = p.html_block;
            pending = None;
            line = &line[close.end..];
            closes_comment = true;
        } else if fence.consume(without_cr(line)) {
            out.push(visit.code_line(line));
            block_start = true;
            indented_code = false;
            continue;
        } else if js_trim(line).is_empty() {
            out.push(line.to_owned());
            block_start = true;
            continue;
        } else if is_indented(line) && !container && (block_start || indented_code) {
            out.push(visit.code_line(line));
            indented_code = true;
            continue;
        } else if !is_indented(line) {
            container = is_container_start(line) || (container && !block_start);
        }
        block_start = false;
        indented_code = false;
        if !closes_comment {
            html_block = is_html_block_comment(line);
        }

        let table_row = is_table_row_line(line);
        let mut i = 0;
        while i < line.len() {
            let tick = line[i..].find('`').map(|n| i + n);
            let opened = next_comment_open(line, i);
            if tick.is_none() && opened.is_none() {
                break;
            }

            if let Some((form, at)) = opened.filter(|(_, at)| tick.is_none_or(|t| *at < t)) {
                let close = line[at + form.open.len()..]
                    .find(form.close)
                    .map(|n| at + form.open.len() + n);
                // GFM splits a row into cells before it reads inline syntax, so a
                // comment in a cell ends in that cell or is text (BBF-51).
                if table_row && close.is_none_or(|c| c > cell_pipe(line, at)) {
                    result.push_str(&line[i..at]);
                    result.push_str(&visit.text_open(form.open));
                    i = at + form.open.len();
                    continue;
                }
                if let Some(close) = close {
                    let end = close + form.close.len();
                    let text_after = !js_trim(&line[end..]).is_empty();
                    let whole_line =
                        !closes_comment && js_trim(&line[..at]).is_empty() && !text_after;
                    let block_goes_on =
                        opens_html_block(html_block, closes_comment, i, form) && text_after;
                    result.push_str(&line[i..at]);
                    result.push_str(&visit.comment(
                        &line[at..end],
                        true,
                        whole_line,
                        block_goes_on,
                    ));
                    i = end;
                    continue;
                }
                let inline = closes_comment || !js_trim(&line[..at]).is_empty();
                // An HTML block ends on the line holding its `-->`, so a `<!--` after
                // that close is block text and cannot reach a later line (BBF-78).
                let reopened = html_block && !form.prose_only && (closes_comment || i > 0);
                let later = if reopened {
                    Later::Text
                } else {
                    find_later_close(&lines, index, form, inline)
                };
                if matches!(later, Later::Text) || (form.prose_only && matches!(later, Later::Open))
                {
                    result.push_str(&line[i..at]);
                    result.push_str(&visit.text_open(form.open));
                    i = at + form.open.len();
                    continue;
                }
                pending = Some(Pending {
                    prefix: format!("{result}{}", &line[i..at]),
                    source: line[at..].to_owned(),
                    close: match later {
                        Later::Close(c) => Some(c),
                        _ => None,
                    },
                    html_block,
                    opens_block: opens_html_block(html_block, closes_comment, i, form),
                });
                break;
            }

            let tick = tick.unwrap_or(0);
            let mut run_end = tick;
            while line.as_bytes().get(run_end) == Some(&b'`') {
                run_end += 1;
            }
            let Some(close_at) = find_closing_run(line, run_end, run_end - tick) else {
                result.push_str(&line[i..run_end]);
                i = run_end;
                continue;
            };
            let end = close_at + (run_end - tick);
            result.push_str(&line[i..tick]);
            result.push_str(&visit.code_span(&line[tick..end]));
            i = end;
        }
        if let Some(p) = &pending {
            if index == lines.len() - 1 {
                out.push(format!(
                    "{}{}",
                    p.prefix,
                    visit.comment(&p.source, false, false, p.opens_block)
                ));
            }
            continue;
        }
        result.push_str(&line[i..]);
        out.push(result);
    }
    out.join("\n")
}
