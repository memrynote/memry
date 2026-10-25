//! The `column-settings` fence: widths read from it and the fence written for
//! a set of widths.

use super::DEFAULT_COLUMN_WIDTH;
use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim, number_to_string};

pub(super) const SETTINGS_FENCE_OPEN: &str = "```column-settings";
pub(super) const SETTINGS_FENCE_CLOSE: &str = "```";

const COUNT_KEYS: [&str; 3] = ["number of columns", "num of cols", "col count"];
const SIZE_KEYS: [&str; 5] = [
    "column size",
    "col size",
    "column width",
    "col width",
    "largest column",
];

struct SettingsEntry<'a> {
    key: String,
    value: &'a str,
    line: &'a str,
}

fn settings_entries(settings: &str) -> Vec<SettingsEntry<'_>> {
    let lines: Vec<&str> = settings.split('\n').collect();
    // `slice(1, -1)`: the fence lines are not entries.
    let inner = if lines.len() > 2 {
        &lines[1..lines.len() - 1]
    } else {
        &[][..]
    };
    inner
        .iter()
        .map(|line| match line.find(':') {
            Some(colon) if colon > 0 => SettingsEntry {
                key: js_trim(&line[..colon]).to_lowercase(),
                value: js_trim(&line[colon + 1..]),
                line,
            },
            _ => SettingsEntry {
                key: String::new(),
                value: "",
                line,
            },
        })
        .collect()
}

fn normalize_widths(widths: &[f64]) -> Vec<f64> {
    let valid: Vec<f64> = widths
        .iter()
        .map(|w| {
            if w.is_finite() && *w > 0.0 {
                *w
            } else {
                DEFAULT_COLUMN_WIDTH
            }
        })
        .collect();
    let mean = valid.iter().fold(0.0, |sum, w| sum + w) / valid.len() as f64;
    valid.iter().map(|w| w / mean).collect()
}

/// MCM's named layouts; the proportions are the editor's approximation.
fn named_layout_widths(name: &str, count: usize) -> Option<Vec<f64>> {
    let key = name.to_lowercase();
    if key == "standard" {
        return None;
    }
    let widths: &[f64] = match (count, key.as_str()) {
        (2, "left" | "first") => &[3.0, 1.0],
        (2, "right" | "second") => &[1.0, 3.0],
        (3, "left" | "first") => &[2.0, 1.0, 1.0],
        (3, "center" | "middle" | "second") => &[1.0, 2.0, 1.0],
        (3, "right" | "third") => &[1.0, 1.0, 2.0],
        _ => return None,
    };
    Some(widths.to_vec())
}

/// `^(\d+(?:\.\d+)?)\s*([a-z%]*)$` (case-insensitive): the number and the
/// lowercased unit of one size item.
fn parse_size_item(item: &str) -> Option<(f64, String)> {
    let bytes = item.as_bytes();
    let mut at = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if at == 0 {
        return None;
    }
    if bytes.get(at) == Some(&b'.') {
        let frac = bytes[at + 1..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if frac > 0 {
            at += 1 + frac;
        }
    }
    let number: f64 = item[..at].parse().ok()?;
    let unit = item[at..].trim_start_matches(is_js_whitespace);
    unit.chars()
        .all(|c| c.is_ascii_alphabetic() || c == '%')
        .then(|| (number, unit.to_ascii_lowercase()))
}

fn size_list_widths(value: &str, count: usize) -> Option<Vec<f64>> {
    let inner = value.strip_prefix('[')?.strip_suffix(']')?;
    if inner.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    let items: Vec<&str> = inner.split(',').map(js_trim).collect();
    if items.len() != count {
        return None;
    }
    let parsed = items
        .iter()
        .map(|item| parse_size_item(item))
        .collect::<Option<Vec<_>>>()?;
    // Mixed units (`[200px, 50%]`) have no proportion to read off.
    if parsed.iter().any(|(_, unit)| *unit != parsed[0].1) {
        return None;
    }
    Some(parsed.into_iter().map(|(number, _)| number).collect())
}

/// `columnWidthsFromSettings`: widths, mean 1, that the settings describe for
/// `count` columns. Equal widths when they say nothing the editor can draw.
pub fn column_widths_from_settings(settings: &str, count: usize) -> Vec<f64> {
    let equal = vec![DEFAULT_COLUMN_WIDTH; count];
    if settings.is_empty() || count < 1 {
        return equal;
    }
    let entries = settings_entries(settings);
    let Some(size) = entries.iter().find(|e| SIZE_KEYS.contains(&e.key.as_str())) else {
        return equal;
    };
    let widths =
        size_list_widths(size.value, count).or_else(|| named_layout_widths(size.value, count));
    widths.map_or(equal, |w| normalize_widths(&w))
}

const WIDTH_TOLERANCE: f64 = 0.02;

fn same_widths(a: &[f64], b: &[f64]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let (na, nb) = (normalize_widths(a), normalize_widths(b));
    na.iter()
        .zip(&nb)
        .all(|(x, y)| (x - y).abs() <= WIDTH_TOLERANCE)
}

/// `${Math.round(value * 10) / 10}%`.
fn format_percent(value: f64) -> String {
    // `Math.round` rounds half up; Rust rounds half away from zero, the same
    // for the positive percentages written here.
    format!("{}%", number_to_string((value * 10.0).round() / 10.0))
}

/// `Number(text)` for an already-trimmed string; `NaN` when it is no number.
fn js_number(text: &str) -> f64 {
    if text.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, radix: u32| {
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        digits.chars().fold(0.0, |acc, c| {
            acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
        })
    };
    if let Some(digits) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return radix(digits, 16);
    }
    if let Some(digits) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
        return radix(digits, 8);
    }
    if let Some(digits) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
        return radix(digits, 2);
    }
    let (negative, unsigned) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let magnitude = if unsigned == "Infinity" {
        f64::INFINITY
    } else if is_decimal_literal(unsigned) {
        unsigned.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        return f64::NAN;
    };
    if negative { -magnitude } else { magnitude }
}

/// `StrUnsignedDecimalLiteral`: digits, an optional fraction (either side may
/// be empty but not both) and an optional exponent.
fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let int = digits(0);
    let mut at = int;
    let mut frac = 0;
    if bytes.get(at) == Some(&b'.') {
        frac = digits(at + 1);
        at += 1 + frac;
    }
    if int == 0 && frac == 0 {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        let mut exp = at + 1;
        if matches!(bytes.get(exp), Some(b'+' | b'-')) {
            exp += 1;
        }
        let exp_digits = digits(exp);
        if exp_digits == 0 {
            return false;
        }
        at = exp + exp_digits;
    }
    at == bytes.len()
}

/// `columnSettingsFor`: the settings fence to write for a region with these
/// column widths. The stored fence comes back byte for byte while it still
/// describes the columns; otherwise only its count and size lines are rewritten.
pub fn column_settings_for(settings: &str, widths: &[f64]) -> String {
    let count = widths.len();
    if !settings.is_empty() {
        let entries = settings_entries(settings);
        let stated = entries
            .iter()
            .find(|e| COUNT_KEYS.contains(&e.key.as_str()))
            .map_or(count as f64, |e| js_number(e.value));
        if stated == count as f64
            && same_widths(&column_widths_from_settings(settings, count), widths)
        {
            return settings.to_owned();
        }
    }

    let kept: Vec<&str> = if settings.is_empty() {
        Vec::new()
    } else {
        settings_entries(settings)
            .into_iter()
            .filter(|e| {
                !COUNT_KEYS.contains(&e.key.as_str()) && !SIZE_KEYS.contains(&e.key.as_str())
            })
            .map(|e| e.line)
            .collect()
    };
    let mut lines = vec![format!("Number of Columns: {count}")];
    let normalized = normalize_widths(widths);
    if !normalized
        .iter()
        .all(|w| (w - 1.0).abs() <= WIDTH_TOLERANCE)
    {
        let total = normalized.iter().fold(0.0, |sum, w| sum + w);
        let sizes: Vec<String> = normalized
            .iter()
            .map(|w| format_percent(w / total * 100.0))
            .collect();
        lines.push(format!("Column Size: [{}]", sizes.join(", ")));
    }
    let mut out = vec![SETTINGS_FENCE_OPEN.to_owned()];
    out.extend(lines);
    out.extend(kept.into_iter().map(str::to_owned));
    out.push(SETTINGS_FENCE_CLOSE.to_owned());
    out.join("\n")
}
