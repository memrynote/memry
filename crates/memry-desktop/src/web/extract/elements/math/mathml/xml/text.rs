//! Character-array and entity helpers of the `sax.js` port.

use super::*;

pub(super) fn substring(s: &[char], a: i64, b: i64) -> &[char] {
    let len = s.len() as i64;
    let (a, b) = (a.clamp(0, len), b.clamp(0, len));
    let (a, b) = if a > b { (b, a) } else { (a, b) };
    &s[a as usize..b as usize]
}

pub(super) fn index_of(s: &[char], needle: &[char], from: usize) -> i64 {
    if from > s.len() {
        return -1;
    }
    (from..=s.len().saturating_sub(needle.len()))
        .find(|&i| s[i..].starts_with(needle))
        .map_or(-1, |i| i as i64)
}

pub(super) fn last_index_of(s: &[char], needle: &[char]) -> i64 {
    if needle.len() > s.len() {
        return -1;
    }
    (0..=s.len() - needle.len())
        .rev()
        .find(|&i| s[i..].starts_with(needle))
        .map_or(-1, |i| i as i64)
}

pub(super) fn chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

pub(super) fn collect(s: &[char]) -> String {
    s.iter().collect()
}

pub(super) fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `s.replace(/[\s<].*/, '')`.
pub(super) fn cut_at_space_or_lt(s: &[char]) -> Vec<char> {
    let Some(i) = s.iter().position(|c| is_js_whitespace(*c) || *c == '<') else {
        return s.to_vec();
    };
    let j = s[i + 1..]
        .iter()
        .position(|c| is_line_terminator(*c))
        .map_or(s.len(), |p| i + 1 + p);
    let mut out = s[..i].to_vec();
    out.extend_from_slice(&s[j..]);
    out
}

/// `String.prototype.replace(/&#?\w+;/g, entityReplacer)` with the XML entity map.
pub(super) fn replace_entities(text: &str) -> String {
    let s = chars(text);
    let mut out = String::new();
    let mut i = 0;
    while i < s.len() {
        if s[i] == '&' {
            let mut j = i + 1;
            if j < s.len() && s[j] == '#' {
                j += 1;
            }
            let word_start = j;
            while j < s.len() && (s[j].is_ascii_alphanumeric() || s[j] == '_') {
                j += 1;
            }
            if j > word_start && j < s.len() && s[j] == ';' {
                out.push_str(&entity(&collect(&s[i + 1..j])));
                i = j + 1;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// `entityReplacer(a)` for the entity name `k` (the match without `&` and `;`).
pub(super) fn entity(k: &str) -> String {
    match k {
        "amp" => return "&".into(),
        "apos" => return "'".into(),
        "gt" => return ">".into(),
        "lt" => return "<".into(),
        "quot" => return "\"".into(),
        _ => {}
    }
    if let Some(rest) = k.strip_prefix('#') {
        let text = rest.replacen('x', "0x", 1);
        return from_char_code(parse_int_auto(&text));
    }
    // `entity not found` is logged and the text kept.
    format!("&{k};")
}

/// `parseInt(text)` with the radix left out: `0x` starts hexadecimal.
pub(super) fn parse_int_auto(text: &str) -> Option<i64> {
    match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        Some(hex) => {
            let digits: String = hex.chars().take_while(char::is_ascii_hexdigit).collect();
            (!digits.is_empty()).then(|| i64::from_str_radix(&digits, 16).unwrap_or(i64::MAX))
        }
        None => parse_int(text),
    }
}

/// `fixedFromCharCode(parseInt(...))`; `None` is NaN (code unit 0) and a lone surrogate becomes
/// U+FFFD.
pub(super) fn from_char_code(code: Option<i64>) -> String {
    let code = code.unwrap_or(0);
    let units: Vec<u16> = if code > 0xffff {
        let c = code - 0x10000;
        vec![
            (0xd800 + ((c as i32) >> 10)) as u16,
            (0xdc00 + (c as i32 & 0x3ff)) as u16,
        ]
    } else {
        vec![code as u16]
    };
    String::from_utf16_lossy(&units)
}

pub(super) fn fix_self_closed(
    s: &[char],
    end: usize,
    tag_name: &str,
    close_map: &mut HashMap<String, i64>,
) -> bool {
    if OBJECT_PROTOTYPE_NAMES.contains(&tag_name) {
        // `closeMap[tagName]` is a function or object there, never `null`, and `< number` is false.
        return false;
    }
    let pos = *close_map.entry(tag_name.to_string()).or_insert_with(|| {
        let close = chars(&format!("</{tag_name}>"));
        let mut pos = last_index_of(s, &close);
        if pos < end as i64 {
            pos = last_index_of(s, &chars(&format!("</{tag_name}")));
        }
        pos
    });
    pos < end as i64
}
