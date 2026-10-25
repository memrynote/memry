//! Port of `packages/editor-schema/src/inline/cell-code-spaces.ts`: whitespace
//! inside a code span in a table row, hidden from the parser as placeholders
//! (BBF-90).

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::Serialize;

use crate::markdown::frontmatter::js::js_trim;
use crate::markdown::shared::markdown_fences::FenceTracker;

static SPACE_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"MEMRYCSP([0-9]+)X").expect("static pattern"));

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MaskedCellCodeSpaces {
    pub markdown: String,
    /// The masked whitespace characters, by placeholder index.
    pub spaces: Vec<String>,
}

/// `UNSAFE_LINE`: `[[\]]|<(?!br\s*\/?>)` (any case): link syntax or HTML other than `<br>`.
fn is_unsafe_line(line: &str) -> bool {
    if line.contains(['[', ']']) {
        return true;
    }
    line.match_indices('<')
        .any(|(at, _)| !is_br_tag(&line[at + 1..]))
}

/// `br\s*\/?>` at the start of `text`.
fn is_br_tag(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 2 || !bytes[..2].eq_ignore_ascii_case(b"br") {
        return false;
    }
    let rest = text[2..].trim_start_matches(crate::markdown::frontmatter::js::is_js_whitespace);
    rest.strip_prefix('/').unwrap_or(rest).starts_with('>')
}

fn mask_code_content(content: &str, spaces: &mut Vec<String>) -> String {
    let stripped = content.len() >= 2
        && content.starts_with(' ')
        && content.ends_with(' ')
        && !js_trim(content).is_empty();
    let inner = if stripped {
        &content[1..content.len() - 1]
    } else {
        content
    };
    let mut masked = String::new();
    for c in inner.chars() {
        if c == ' ' || c == '\t' {
            spaces.push(c.to_string());
            masked.push_str(&format!("MEMRYCSP{}X", spaces.len() - 1));
        } else {
            masked.push(c);
        }
    }
    if stripped {
        format!(" {masked} ")
    } else {
        masked
    }
}

/// Start of the first backtick run exactly `length` long at or after `from`
/// (`(?<!`)RUN(?!`)` searched from `from`).
fn find_closer(line: &str, from: usize, length: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut at = from;
    while at < bytes.len() {
        if bytes[at] != b'`' {
            at += 1;
            continue;
        }
        let run = bytes[at..].iter().take_while(|b| **b == b'`').count();
        let starts_run = at == 0 || bytes[at - 1] != b'`';
        if starts_run && run == length {
            return Some(at);
        }
        at += run;
    }
    None
}

fn mask_line(line: &str, spaces: &mut Vec<String>) -> String {
    let bytes = line.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < line.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            let next = line[i + 1..].chars().next().expect("a next character");
            out.push('\\');
            out.push(next);
            i += 1 + next.len_utf8();
            continue;
        }
        if bytes[i] != b'`' {
            let c = line[i..].chars().next().expect("a character");
            out.push(c);
            i += c.len_utf8();
            continue;
        }
        let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
        let Some(close) = find_closer(line, i + run, run) else {
            out.push_str(&line[i..i + run]);
            i += run;
            continue;
        };
        out.push_str(&line[i..i + run]);
        out.push_str(&mask_code_content(&line[i + run..close], spaces));
        out.push_str(&line[close..close + run]);
        i = close + run;
    }
    out
}

/// Every space and tab a code span in a table row keeps travels as a
/// placeholder. Only lines with a pipe, outside fences, are touched, and never a
/// line with link syntax or HTML other than `<br>`.
pub fn mask_cell_code_spaces(markdown: &str) -> MaskedCellCodeSpaces {
    let unchanged = || MaskedCellCodeSpaces {
        markdown: markdown.to_owned(),
        spaces: Vec::new(),
    };
    if !markdown.contains('`') || !markdown.contains('|') {
        return unchanged();
    }
    let mut spaces = Vec::new();
    let mut fence = FenceTracker::new();
    let masked: Vec<String> = markdown
        .split('\n')
        .map(|line| {
            if fence.consume(line) || !line.contains('|') || is_unsafe_line(line) {
                return line.to_owned();
            }
            mask_line(line, &mut spaces)
        })
        .collect();
    if spaces.is_empty() {
        return unchanged();
    }
    MaskedCellCodeSpaces {
        markdown: masked.join("\n"),
        spaces,
    }
}

/// A placeholder with no masked character is the author's own text and stays.
pub fn restore_cell_code_spaces(text: &str, spaces: &[String]) -> String {
    if spaces.is_empty() {
        return text.to_owned();
    }
    SPACE_TOKEN
        .replace_all(text, |caps: &Captures| {
            caps[1]
                .parse::<usize>()
                .ok()
                .and_then(|index| spaces.get(index))
                .cloned()
                .unwrap_or_else(|| caps[0].to_owned())
        })
        .into_owned()
}
