//! Scalar styles of js-yaml 3.15.1 `dumper.js`: `chooseScalarStyle`,
//! `writeScalar`, folding and double-quote escaping.
//!
//! js-yaml walks UTF-16 code units. Every code unit of a character above
//! U+FFFF (a surrogate) is non-printable, so such a string always takes the
//! double-quoted style, and that style escapes the pair as one `\UXXXXXXXX`.
//! Treating those characters as non-printable here is the same decision.

use crate::markdown::frontmatter::scalar::{IMPLICIT, Ty};
use crate::markdown::frontmatter::value::YamlValue;

const DEPRECATED_BOOLEANS: [&str; 16] = [
    "y", "Y", "yes", "Yes", "YES", "on", "On", "ON", "n", "N", "no", "No", "NO", "off", "Off",
    "OFF",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Style {
    Plain,
    Single,
    Literal,
    Folded,
    Double,
}

fn is_whitespace(c: char) -> bool {
    c == ' ' || c == '\t'
}

fn is_printable(c: char) -> bool {
    let c = c as u32;
    (0x20..=0x7E).contains(&c)
        || ((0xA1..=0xD7FF).contains(&c) && c != 0x2028 && c != 0x2029)
        || ((0xE000..=0xFFFD).contains(&c) && c != 0xFEFF)
}

fn is_ns_char(c: char) -> bool {
    is_printable(c) && !is_whitespace(c) && c != '\u{FEFF}' && c != '\r' && c != '\n'
}

fn is_plain_safe(c: char, prev: Option<char>) -> bool {
    is_printable(c)
        && c != '\u{FEFF}'
        && !matches!(c, ',' | '[' | ']' | '{' | '}' | ':')
        && (c != '#' || prev.is_some_and(is_ns_char))
}

fn is_plain_safe_first(c: char) -> bool {
    is_printable(c)
        && c != '\u{FEFF}'
        && !is_whitespace(c)
        && !matches!(
            c,
            '-' | '?'
                | ':'
                | ','
                | '['
                | ']'
                | '{'
                | '}'
                | '#'
                | '&'
                | '*'
                | '!'
                | '|'
                | '='
                | '>'
                | '\''
                | '"'
                | '%'
                | '@'
                | '`'
        )
}

fn need_indent_indicator(text: &str) -> bool {
    text.trim_start_matches('\n').starts_with(' ')
}

fn choose_scalar_style(
    text: &[char],
    single_line_only: bool,
    indent_per_level: usize,
    line_width: i64,
    ambiguous: bool,
) -> Style {
    let track_width = line_width != -1;
    let mut has_line_break = false;
    let mut has_foldable_line = false;
    let mut previous_break: i64 = -1;
    let mut plain = is_plain_safe_first(text[0]) && !is_whitespace(text[text.len() - 1]);
    let foldable = |end: usize, previous_break: i64| {
        (end as i64 - previous_break - 1 > line_width)
            && text.get((previous_break + 1) as usize) != Some(&' ')
    };

    for (i, &c) in text.iter().enumerate() {
        if !single_line_only && c == '\n' {
            has_line_break = true;
            if track_width {
                has_foldable_line = has_foldable_line || foldable(i, previous_break);
                previous_break = i as i64;
            }
        } else if !is_printable(c) {
            return Style::Double;
        }
        let prev = (i > 0).then(|| text[i - 1]);
        plain = plain && is_plain_safe(c, prev);
    }
    if !single_line_only {
        has_foldable_line =
            has_foldable_line || (track_width && foldable(text.len(), previous_break));
    }
    if !has_line_break && !has_foldable_line {
        return if plain && !ambiguous {
            Style::Plain
        } else {
            Style::Single
        };
    }
    let as_string: String = text.iter().collect();
    if indent_per_level > 9 && need_indent_indicator(&as_string) {
        return Style::Double;
    }
    if has_foldable_line {
        Style::Folded
    } else {
        Style::Literal
    }
}

fn indent_string(text: &str, spaces: usize) -> String {
    let pad = " ".repeat(spaces);
    let mut out = String::new();
    for line in text.split_inclusive('\n') {
        if !line.is_empty() && line != "\n" {
            out.push_str(&pad);
        }
        out.push_str(line);
    }
    out
}

fn block_header(text: &str, indent_per_level: usize) -> String {
    let indicator = if need_indent_indicator(text) {
        indent_per_level.to_string()
    } else {
        String::new()
    };
    let clip = text.ends_with('\n');
    let keep = clip && (text.ends_with("\n\n") || text == "\n");
    let chomp = if keep {
        "+"
    } else if clip {
        ""
    } else {
        "-"
    };
    format!("{indicator}{chomp}\n")
}

fn drop_ending_newline(text: String) -> String {
    match text.strip_suffix('\n') {
        Some(rest) => rest.to_owned(),
        None => text,
    }
}

fn fold_line(line: &str, width: i64) -> String {
    if line.is_empty() || line.starts_with(' ') {
        return line.to_owned();
    }
    let chars: Vec<char> = line.chars().collect();
    let len = chars.len() as i64;
    let (mut start, mut curr, mut next) = (0i64, 0i64, 0i64);
    let mut result = String::new();
    let mut search = 0usize;
    while let Some(index) =
        (search..chars.len().saturating_sub(1)).find(|&i| chars[i] == ' ' && chars[i + 1] != ' ')
    {
        next = index as i64;
        if next - start > width {
            let end = if curr > start { curr } else { next };
            result.push('\n');
            result.extend(&chars[start as usize..end as usize]);
            start = end + 1;
        }
        curr = next;
        search = index + 2;
    }
    let _ = next;
    result.push('\n');
    if len - start > width && curr > start {
        result.extend(&chars[start as usize..curr as usize]);
        result.push('\n');
        result.extend(&chars[curr as usize + 1..]);
    } else {
        result.extend(&chars[start as usize..]);
    }
    result[1..].to_owned()
}

fn fold_string(text: &str, width: i64) -> String {
    let first_break = text.find('\n').unwrap_or(text.len());
    let mut result = fold_line(&text[..first_break], width);
    let mut previous_more_indented = text.starts_with('\n') || text.starts_with(' ');
    let mut at = first_break;
    while at < text.len() {
        let run_end = at + text[at..].find(|c| c != '\n').unwrap_or(text.len() - at);
        let line_end = run_end + text[run_end..].find('\n').unwrap_or(text.len() - run_end);
        let prefix = &text[at..run_end];
        let line = &text[run_end..line_end];
        let more_indented = line.starts_with(' ');
        result.push_str(prefix);
        if !previous_more_indented && !more_indented && !line.is_empty() {
            result.push('\n');
        }
        result.push_str(&fold_line(line, width));
        previous_more_indented = more_indented;
        at = line_end;
    }
    result
}

fn encode_hex(code: u32) -> String {
    let (handle, length) = if code <= 0xFF {
        ('x', 2)
    } else if code <= 0xFFFF {
        ('u', 4)
    } else {
        ('U', 8)
    };
    format!("\\{handle}{code:0length$X}")
}

fn escape_string(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        let code = c as u32;
        let escape = match code {
            0x00 => Some("\\0"),
            0x07 => Some("\\a"),
            0x08 => Some("\\b"),
            0x09 => Some("\\t"),
            0x0A => Some("\\n"),
            0x0B => Some("\\v"),
            0x0C => Some("\\f"),
            0x0D => Some("\\r"),
            0x1B => Some("\\e"),
            0x22 => Some("\\\""),
            0x5C => Some("\\\\"),
            0x85 => Some("\\N"),
            0xA0 => Some("\\_"),
            0x2028 => Some("\\L"),
            0x2029 => Some("\\P"),
            _ => None,
        };
        match escape {
            Some(sequence) => out.push_str(sequence),
            None if is_printable(c) => out.push(c),
            None => out.push_str(&encode_hex(code)),
        }
    }
    out
}

/// `writeScalar`: the text of one string scalar at nesting `level`.
pub(super) fn write_scalar(text: &str, level: usize, is_key: bool) -> String {
    const INDENT: usize = 2;
    const LINE_WIDTH: i64 = 80;
    if text.is_empty() {
        return "''".to_owned();
    }
    if DEPRECATED_BOOLEANS.contains(&text) {
        return format!("'{text}'");
    }
    let indent = INDENT * level.max(1);
    let line_width = (LINE_WIDTH - indent as i64).max(LINE_WIDTH.min(40));
    let chars: Vec<char> = text.chars().collect();
    let value = YamlValue::String(text.to_owned());
    let ambiguous = IMPLICIT.iter().any(|ty: &Ty| ty.resolve(&value));
    match choose_scalar_style(&chars, is_key, INDENT, line_width, ambiguous) {
        Style::Plain => text.to_owned(),
        Style::Single => format!("'{}'", text.replace('\'', "''")),
        Style::Literal => format!(
            "|{}{}",
            block_header(text, INDENT),
            drop_ending_newline(indent_string(text, indent))
        ),
        Style::Folded => format!(
            ">{}{}",
            block_header(text, INDENT),
            drop_ending_newline(indent_string(&fold_string(text, line_width), indent))
        ),
        Style::Double => format!("\"{}\"", escape_string(text)),
    }
}
