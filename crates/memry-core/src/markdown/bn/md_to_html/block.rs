//! Block tokenizer: `tokenize` and `tryParseTable`.

use super::scan::{
    ListMatch, atx_heading, chars_to_string, fence_close, fence_open, has_list_prefix, is_blank,
    is_hr, is_html_block_start, is_quote_start, is_setext_eq, is_setext_marker, is_table_row,
    is_table_separator, list_item, starts_fence, starts_heading, strip_quote, trim, ws_len,
};

type Line = Vec<char>;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum ListKind {
    Bullet,
    Ordered,
    Task,
}

pub(super) struct ListItem {
    pub kind: ListKind,
    pub checked: bool,
    pub start: Option<f64>,
    pub content: String,
    pub child_content: Option<String>,
}

pub(super) struct Table {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub alignments: Vec<Option<&'static str>>,
}

pub(super) enum Token {
    Heading { level: usize, content: String },
    Paragraph(String),
    CodeBlock { language: String, code: String },
    Blockquote(String),
    Hr,
    ListItem(ListItem),
    Table(Table),
    RawHtml(String),
}

fn join(lines: &[&[char]]) -> String {
    lines
        .iter()
        .map(|l| chars_to_string(l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `parseInt(marker, 10)` of `\d+[.)]`.
fn parse_int(marker: &str) -> f64 {
    let digits: String = marker.chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<f64>().unwrap_or(f64::INFINITY)
}

pub(super) fn tokenize(markdown: &str) -> Vec<Token> {
    let lines: Vec<Line> = markdown.split('\n').map(|l| l.chars().collect()).collect();
    let mut tokens: Vec<Token> = Vec::new();
    let mut i = 0;
    let mut prev_blank = true;

    while i < lines.len() {
        let line = &lines[i][..];
        if is_blank(line) {
            prev_blank = true;
            i += 1;
            continue;
        }

        if let Some((ch, len, language)) = fence_open(line) {
            let mut code: Vec<&[char]> = Vec::new();
            i += 1;
            while i < lines.len() {
                if fence_close(&lines[i], ch, len) {
                    i += 1;
                    break;
                }
                code.push(&lines[i]);
                i += 1;
            }
            tokens.push(Token::CodeBlock {
                language,
                code: join(&code),
            });
            prev_blank = false;
            continue;
        }

        if let Some((level, content)) = atx_heading(line) {
            tokens.push(Token::Heading { level, content });
            prev_blank = false;
            i += 1;
            continue;
        }

        if is_hr(line) {
            let all_dashes = {
                let t = trim(line);
                !t.is_empty() && t.iter().all(|&c| c == '-')
            };
            if !prev_blank
                && all_dashes
                && let Some(Token::Paragraph(content)) = tokens.last_mut()
            {
                let content = std::mem::take(content);
                *tokens.last_mut().expect("last") = Token::Heading { level: 2, content };
                prev_blank = false;
                i += 1;
                continue;
            }
            tokens.push(Token::Hr);
            prev_blank = false;
            i += 1;
            continue;
        }

        if i + 1 < lines.len() && is_setext_eq(&lines[i + 1]) {
            tokens.push(Token::Heading {
                level: 1,
                content: chars_to_string(trim(line)),
            });
            prev_blank = false;
            i += 2;
            continue;
        }

        if let Some((table, next)) = try_parse_table(&lines, i) {
            tokens.push(Token::Table(table));
            i = next;
            prev_blank = false;
            continue;
        }

        if is_quote_start(line) {
            let mut quote: Vec<&[char]> = Vec::new();
            while i < lines.len() && is_quote_start(&lines[i]) {
                quote.push(strip_quote(&lines[i]));
                i += 1;
            }
            while i < lines.len() {
                let cur = &lines[i][..];
                if is_blank(cur)
                    || is_quote_start(cur)
                    || starts_heading(cur)
                    || starts_fence(cur)
                    || is_hr(cur)
                    || has_list_prefix(cur)
                    || is_table_row(cur)
                {
                    break;
                }
                quote.push(cur);
                i += 1;
            }
            tokens.push(Token::Blockquote(join(&quote)));
            prev_blank = false;
            continue;
        }

        if let Some(m) = list_item(line) {
            let (item, next) = parse_list_item(&lines, i, m);
            tokens.push(Token::ListItem(item));
            i = next;
            prev_blank = false;
            continue;
        }

        if is_html_block_start(line) {
            let mut html: Vec<&[char]> = Vec::new();
            while i < lines.len() && !is_blank(&lines[i]) {
                html.push(&lines[i]);
                i += 1;
            }
            tokens.push(Token::RawHtml(join(&html)));
            prev_blank = false;
            continue;
        }

        let mut para: Vec<&[char]> = vec![line];
        i += 1;
        while i < lines.len() {
            let next = &lines[i][..];
            if is_blank(next)
                || starts_heading(next)
                || starts_fence(next)
                || is_quote_start(next)
                || is_hr(next)
                || has_list_prefix(next)
                || is_table_row(next)
                || is_html_block_start(next)
                || (i + 1 < lines.len() && is_setext_marker(&lines[i + 1]) && !is_blank(next))
            {
                break;
            }
            para.push(next);
            i += 1;
        }
        let stripped: Vec<&[char]> = para
            .iter()
            .map(|l| &l[l.iter().take(3).take_while(|&&c| c == ' ').count()..])
            .collect();
        let joined = join(&stripped);
        tokens.push(Token::Paragraph(
            joined.trim_end_matches([' ', '\t']).to_string(),
        ));
        prev_blank = false;
    }
    tokens
}

fn parse_list_item(lines: &[Line], first: usize, m: ListMatch) -> (ListItem, usize) {
    let (kind, checked, start) = if let Some(cb) = m.checkbox {
        (ListKind::Task, cb != ' ', None)
    } else if m.marker.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        (ListKind::Ordered, false, Some(parse_int(&m.marker)))
    } else {
        (ListKind::Bullet, false, None)
    };
    let marker_len = m.marker.chars().count();
    let content_indent =
        m.indent + marker_len + m.marker_spaces + if m.checkbox.is_some() { 4 } else { 0 };
    let min_child = m.indent + 1;

    let belongs = |l: &[char]| -> bool {
        if is_blank(l) {
            return true;
        }
        let ind = ws_len(l);
        ind >= content_indent || (ind >= min_child && has_list_prefix(l))
    };

    let mut i = first + 1;
    let mut sub: Vec<&[char]> = Vec::new();
    while i < lines.len() {
        let cur = &lines[i][..];
        if is_blank(cur) {
            let mut ahead = i + 1;
            while ahead < lines.len() && is_blank(&lines[ahead]) {
                ahead += 1;
            }
            if ahead < lines.len() && belongs(&lines[ahead]) {
                sub.push(&[]);
                i += 1;
                continue;
            }
            break;
        }
        if !belongs(cur) {
            break;
        }
        let ind = ws_len(cur);
        sub.push(
            &cur[if ind >= content_indent {
                content_indent
            } else {
                min_child
            }..],
        );
        i += 1;
    }
    let joined = join(&sub);
    let child = joined.trim_matches('\n');
    (
        ListItem {
            kind,
            checked,
            start,
            content: chars_to_string(trim(&m.content.chars().collect::<Vec<_>>())),
            child_content: (!child.is_empty()).then(|| child.to_string()),
        },
        i,
    )
}

fn try_parse_table(lines: &[Line], start: usize) -> Option<(Table, usize)> {
    if start + 1 >= lines.len() {
        return None;
    }
    let header = &lines[start];
    let sep = &lines[start + 1];
    if !sep.contains(&'|') || !is_table_separator(sep) || !header.contains(&'|') {
        return None;
    }
    let mut rows = Vec::new();
    let mut i = start + 2;
    while i < lines.len() && lines[i].contains(&'|') {
        rows.push(parse_pipe_cells(&lines[i]));
        i += 1;
    }
    let alignments = parse_pipe_cells(sep)
        .iter()
        .map(|cell| {
            let left = cell.starts_with(':');
            let right = cell.ends_with(':');
            match (left, right) {
                (true, true) => Some("center"),
                (false, true) => Some("right"),
                (true, false) => Some("left"),
                _ => None,
            }
        })
        .collect();
    Some((
        Table {
            headers: parse_pipe_cells(header),
            rows,
            alignments,
        },
        i,
    ))
}

fn parse_pipe_cells(line: &[char]) -> Vec<String> {
    let t = trim(line);
    let t = t.strip_prefix(&['|']).unwrap_or(t);
    let content = t.strip_suffix(&['|']).unwrap_or(t);
    let mut cells = Vec::new();
    let mut current: Vec<char> = Vec::new();
    let mut i = 0;
    while i < content.len() {
        if content[i] == '\\' && content.get(i + 1) == Some(&'|') {
            current.push('|');
            i += 1;
        } else if content[i] == '|' {
            cells.push(chars_to_string(trim(&current)));
            current.clear();
        } else {
            current.push(content[i]);
        }
        i += 1;
    }
    cells.push(chars_to_string(trim(&current)));
    cells
}
