//! BlockNote 0.54's block tokenizer (`api/parsers/markdown/markdownToHtml.ts`
//! `tokenize`), line for line.
//!
//! Every regex there is ported by hand; `\s` is JavaScript's whitespace set
//! and `trim()` is JavaScript's. Tables and raw HTML blocks are recognised so
//! they can be routed to the fallback, and never built.

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::prepare::fence_line;
use super::shapes::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ListType {
    Bullet,
    Ordered,
    Task,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum TokenKind {
    Heading {
        level: u8,
        content: String,
    },
    Paragraph {
        content: String,
    },
    Code {
        language: String,
        code: String,
    },
    Quote {
        content: String,
    },
    Rule,
    ListItem {
        list: ListType,
        content: String,
        /// `parseInt` of an ordered marker; `None` when it has too many digits
        /// to be carried faithfully.
        start: Option<Option<u32>>,
        checked: bool,
        child: Option<String>,
    },
    Table,
    RawHtml,
}

/// A token and the lines `[start, end)` it was read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Token {
    pub kind: TokenKind,
    pub start: usize,
    pub end: usize,
}

/// `tokenize(markdown)`.
pub(super) fn tokenize(markdown: &str) -> Vec<Token> {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut tokens: Vec<Token> = Vec::new();
    let mut i = 0;
    let mut prev_blank = true;
    let push = |tokens: &mut Vec<Token>, kind, start, end| tokens.push(Token { kind, start, end });

    while i < lines.len() {
        let line = lines[i];
        let start = i;
        if blank(line) {
            prev_blank = true;
            i += 1;
            continue;
        }

        if let Some((fence_char, fence_len, info)) = fence_line(line) {
            let mut code = Vec::new();
            i += 1;
            while i < lines.len() {
                if let Some((c, len, rest)) = fence_line(lines[i])
                    && c == fence_char
                    && len >= fence_len
                    && rest.chars().all(is_js_whitespace)
                {
                    i += 1;
                    break;
                }
                code.push(lines[i]);
                i += 1;
            }
            let kind = TokenKind::Code {
                language: js_trim(info).to_owned(),
                code: code.join("\n"),
            };
            push(&mut tokens, kind, start, i);
            prev_blank = false;
            continue;
        }

        if let Some((level, content)) = heading(line) {
            push(
                &mut tokens,
                TokenKind::Heading { level, content },
                start,
                i + 1,
            );
            prev_blank = false;
            i += 1;
            continue;
        }

        if is_rule(line) {
            let trimmed = js_trim(line);
            let setext = !prev_blank
                && trimmed.chars().all(|c| c == '-')
                && matches!(
                    tokens.last(),
                    Some(Token {
                        kind: TokenKind::Paragraph { .. },
                        ..
                    })
                );
            if setext && let Some(last) = tokens.last_mut() {
                if let TokenKind::Paragraph { content } = &last.kind {
                    last.kind = TokenKind::Heading {
                        level: 2,
                        content: content.clone(),
                    };
                }
                last.end = i + 1;
            } else {
                push(&mut tokens, TokenKind::Rule, start, i + 1);
            }
            prev_blank = false;
            i += 1;
            continue;
        }

        if i + 1 < lines.len() && is_setext_h1(lines[i + 1]) {
            let content = js_trim(line).to_owned();
            push(
                &mut tokens,
                TokenKind::Heading { level: 1, content },
                start,
                i + 2,
            );
            prev_blank = false;
            i += 2;
            continue;
        }

        if let Some(end) = table_end(&lines, i) {
            push(&mut tokens, TokenKind::Table, start, end);
            i = end;
            prev_blank = false;
            continue;
        }

        if starts_quote(line) {
            let mut quoted = Vec::new();
            while i < lines.len() && starts_quote(lines[i]) {
                let current = lines[i];
                let after = skip_chars(current, leading_ws(current));
                let after = &after[1..];
                let after = after.strip_prefix(is_js_whitespace).unwrap_or(after);
                quoted.push(after.to_owned());
                i += 1;
            }
            while i < lines.len() {
                let current = lines[i];
                if blank(current)
                    || starts_quote(current)
                    || starts_heading(current)
                    || starts_fence(current)
                    || is_rule(current)
                    || starts_list_item(current)
                    || is_pipe_row(current)
                {
                    break;
                }
                quoted.push(current.to_owned());
                i += 1;
            }
            let content = quoted.join("\n");
            push(&mut tokens, TokenKind::Quote { content }, start, i);
            prev_blank = false;
            continue;
        }

        if let Some(item) = list_item(&lines, &mut i) {
            push(&mut tokens, item, start, i);
            prev_blank = false;
            continue;
        }

        if is_html_block_start(line) {
            while i < lines.len() && !blank(lines[i]) {
                i += 1;
            }
            push(&mut tokens, TokenKind::RawHtml, start, i);
            prev_blank = false;
            continue;
        }

        let mut paragraph = vec![line];
        i += 1;
        while i < lines.len() {
            let next = lines[i];
            if blank(next)
                || starts_heading(next)
                || starts_fence(next)
                || starts_quote(next)
                || is_rule(next)
                || starts_list_item(next)
                || is_pipe_row(next)
                || is_html_block_start(next)
                || (i + 1 < lines.len() && is_setext_underline(lines[i + 1]))
            {
                break;
            }
            paragraph.push(next);
            i += 1;
        }
        let content = paragraph
            .iter()
            .map(|line| {
                let spaces = line.chars().take_while(|c| *c == ' ').count().min(3);
                &line[spaces..]
            })
            .collect::<Vec<_>>()
            .join("\n");
        let content = content.trim_end_matches([' ', '\t']).to_owned();
        push(&mut tokens, TokenKind::Paragraph { content }, start, i);
        prev_blank = false;
    }
    tokens
}

/// The list-item branch of `tokenize`, consuming the item's lines.
fn list_item(lines: &[&str], i: &mut usize) -> Option<TokenKind> {
    let line = lines[*i];
    let indent = leading_ws(line);
    let (marker, after) = list_marker(skip_chars(line, indent))?;
    let marker_spaces = after.chars().take_while(|c| is_js_whitespace(*c)).count();
    if marker_spaces == 0 {
        return None;
    }
    let after = skip_chars(after, marker_spaces);
    // `(\[[ xX]\] )?`: only a box followed by a space counts.
    let checkbox = ["[ ] ", "[x] ", "[X] "]
        .iter()
        .find(|box_| after.starts_with(**box_))
        .copied();
    let first_line = checkbox.map_or(after, |box_| &after[box_.len()..]);

    let (list, start, checked) = if let Some(box_) = checkbox {
        (ListType::Task, None, box_ != "[ ] ")
    } else if marker.starts_with(|c: char| c.is_ascii_digit()) {
        let digits = &marker[..marker.len() - 1];
        let start = if digits.trim_start_matches('0').len() > 9 {
            None
        } else {
            Some(digits.parse::<u32>().unwrap_or(0))
        };
        (ListType::Ordered, Some(start), false)
    } else {
        (ListType::Bullet, None, false)
    };

    let content_indent =
        indent + marker.len() + marker_spaces + checkbox.map_or(0, |box_| box_.len());
    let min_child_indent = indent + 1;
    let belongs = |candidate: &str| {
        if blank(candidate) {
            return true;
        }
        let at = leading_ws(candidate);
        at >= content_indent || (at >= min_child_indent && starts_list_item(candidate))
    };

    *i += 1;
    let mut sub_lines: Vec<&str> = Vec::new();
    while *i < lines.len() {
        let current = lines[*i];
        if blank(current) {
            let mut ahead = *i + 1;
            while ahead < lines.len() && blank(lines[ahead]) {
                ahead += 1;
            }
            if ahead < lines.len() && belongs(lines[ahead]) {
                sub_lines.push("");
                *i += 1;
                continue;
            }
            break;
        }
        if !belongs(current) {
            break;
        }
        let at = leading_ws(current);
        sub_lines.push(skip_chars(
            current,
            if at >= content_indent {
                content_indent
            } else {
                min_child_indent
            },
        ));
        *i += 1;
    }
    let child = sub_lines.join("\n");
    let child = child.trim_matches('\n');
    Some(TokenKind::ListItem {
        list,
        content: js_trim(first_line).to_owned(),
        start,
        checked,
        child: (!child.is_empty()).then(|| child.to_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_heading_keeps_its_content_and_drops_a_closing_sequence() {
        assert_eq!(heading("## Trailing ##"), Some((2, "Trailing".to_owned())));
        assert_eq!(heading("# #"), Some((1, "#".to_owned())));
        assert_eq!(heading("# a # b"), Some((1, "a # b".to_owned())));
        assert_eq!(heading("#NoSpace"), None);
        assert_eq!(heading("####### seven"), None);
        assert_eq!(heading("# "), None);
    }

    #[test]
    fn an_empty_list_item_needs_the_space_after_its_marker() {
        let tokens = tokenize("1. \n2.");
        assert!(matches!(tokens[0].kind, TokenKind::ListItem { .. }));
        assert!(matches!(tokens[1].kind, TokenKind::Paragraph { .. }));
    }

    #[test]
    fn a_dash_line_under_a_paragraph_makes_it_a_heading() {
        let tokens = tokenize("a\nb\n---");
        assert_eq!(
            tokens[1].kind,
            TokenKind::Heading {
                level: 2,
                content: "b".to_owned()
            }
        );
    }
}
