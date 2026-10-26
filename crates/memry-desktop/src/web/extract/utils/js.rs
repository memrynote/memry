//! JavaScript string semantics the port depends on.
//!
//! Defuddle runs on JS strings (UTF-16), so lengths, slices, trimming and splitting differ from
//! Rust's UTF-8 `str` methods. Every function here names the JS method it reproduces and is
//! pinned by a test whose expected value was read from Node.

/// `String.prototype.trim` and regex `\s` share one set: ECMAScript WhiteSpace plus
/// LineTerminator. Rust's `char::is_whitespace` differs (it lacks U+FEFF and adds U+0085).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `s.length`: the number of UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(start, end)` for non-negative bounds. A bound that falls inside a surrogate pair
/// would leave a lone surrogate in JS, which a Rust `String` cannot hold. The half that would be
/// left over becomes U+FFFD, which is what UTF-8 encoding of that JS string produces on the wire.
pub fn utf16_slice(s: &str, start: usize, end: usize) -> String {
    let mut out = String::new();
    let mut index = 0usize;
    for c in s.chars() {
        let width = c.len_utf16();
        let next = index + width;
        if next > start && index < end {
            if index >= start && next <= end {
                out.push(c);
            } else {
                out.push('\u{fffd}');
            }
        }
        index = next;
        if index >= end {
            break;
        }
    }
    out
}

/// `s.substr(start, length)` for non-negative arguments.
pub fn utf16_substr(s: &str, start: usize, length: usize) -> String {
    utf16_slice(s, start, start.saturating_add(length))
}

/// `s.charAt(index)`: the code unit as a string, empty past the end. A lone surrogate becomes
/// U+FFFD, as in `utf16_slice`.
pub fn char_at(s: &str, index: usize) -> String {
    utf16_slice(s, index, index + 1)
}

/// `s.split(/\s+/)`. A leading or trailing run of whitespace yields an empty first or last
/// element, and the empty string yields `[""]`.
pub fn split_whitespace_runs(s: &str) -> Vec<&str> {
    split_runs(s, is_js_whitespace)
}

/// `s.split(/[class]+/)` where `separator` tests one character of the class: runs of separators
/// split, and a leading or trailing run yields an empty first or last element.
pub fn split_runs(s: &str, separator: impl Fn(char) -> bool) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut in_run = false;
    let mut run_start = 0usize;
    for (i, c) in s.char_indices() {
        if separator(c) {
            if !in_run {
                in_run = true;
                run_start = i;
            }
        } else if in_run {
            parts.push(&s[start..run_start]);
            start = i;
            in_run = false;
        }
    }
    if in_run {
        parts.push(&s[start..run_start]);
        parts.push("");
    } else {
        parts.push(&s[start..]);
    }
    parts
}

/// A string as JS indexes it: UTF-16 code units. `indexOf` positions and `length` of the page
/// text feed thresholds ("near the start", "within 300 characters of the end").
pub struct Utf16Text(Vec<u16>);

impl Utf16Text {
    pub fn new(s: &str) -> Self {
        Utf16Text(s.encode_utf16().collect())
    }

    /// `s.length`.
    pub fn unit_len(&self) -> i64 {
        self.0.len() as i64
    }

    /// `s.indexOf(needle)` for `needle` given as its code units; -1 when absent.
    pub fn index_of(&self, needle: &[u16]) -> i64 {
        if needle.is_empty() {
            return 0;
        }
        let Some(&first) = needle.first() else {
            return 0;
        };
        let last_start = match self.0.len().checked_sub(needle.len()) {
            Some(n) => n,
            None => return -1,
        };
        for at in 0..=last_start {
            if self.0[at] == first && &self.0[at..at + needle.len()] == needle {
                return at as i64;
            }
        }
        -1
    }
}

/// `s.substring(0, n)` as code units: a cut through a surrogate pair stays a lone surrogate,
/// which only `Utf16Text::index_of` can compare.
pub fn utf16_prefix(s: &str, n: usize) -> Vec<u16> {
    s.encode_utf16().take(n).collect()
}

/// JS `\s` as a regex class.
pub const WS: &str = r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";
/// The members of `WS` without brackets, to build larger classes.
pub const WS_BODY: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// `s.toLowerCase()`. Rust's `str::to_lowercase` applies the same language-neutral Unicode
/// mapping, including the final-sigma rule.
pub fn to_lower(s: &str) -> String {
    s.to_lowercase()
}

/// `parseInt(s, 10)`; `None` stands for NaN. Digits beyond `i64` saturate, which never changes a
/// comparison the port makes.
pub fn parse_int(s: &str) -> Option<i64> {
    let s = s.trim_start_matches(is_js_whitespace);
    let (negative, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        return None;
    }
    let mut value: i64 = 0;
    for b in digits.bytes().take(end) {
        value = value.saturating_mul(10).saturating_add(i64::from(b - b'0'));
    }
    Some(if negative { -value } else { value })
}

/// `parseFloat(s)`; `None` stands for NaN. Reads the longest decimal prefix, including a
/// fraction and an exponent, and `Infinity`.
pub fn parse_float(s: &str) -> Option<f64> {
    let s = s.trim_start_matches(is_js_whitespace);
    let bytes = s.as_bytes();
    let mut i = 0usize;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    if s[i..].starts_with("Infinity") {
        let value = f64::INFINITY;
        return Some(if bytes[0] == b'-' { -value } else { value });
    }
    let digits_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let mut mantissa_digits = i - digits_start;
    if i < bytes.len() && bytes[i] == b'.' {
        let frac_start = i + 1;
        let mut j = frac_start;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > frac_start || mantissa_digits > 0 {
            mantissa_digits += j - frac_start;
            i = j;
        }
    }
    if mantissa_digits == 0 {
        return None;
    }
    if i < bytes.len() && matches!(bytes[i], b'e' | b'E') {
        let mut j = i + 1;
        if j < bytes.len() && matches!(bytes[j], b'+' | b'-') {
            j += 1;
        }
        let exp_start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > exp_start {
            i = j;
        }
    }
    s[..i].parse::<f64>().ok()
}

/// `Number(s)` for a string; NaN for what is not a StringNumericLiteral. Whitespace trims, the
/// empty string is 0, and `0x`, `0o` and `0b` literals take no sign.
pub fn to_number(s: &str) -> f64 {
    let s = trim(s);
    if s.is_empty() {
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
    let lower = s.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("0x") {
        return radix(rest, 16);
    }
    if let Some(rest) = lower.strip_prefix("0o") {
        return radix(rest, 8);
    }
    if let Some(rest) = lower.strip_prefix("0b") {
        return radix(rest, 2);
    }
    let (negative, unsigned) = match s.as_bytes()[0] {
        b'-' => (true, &s[1..]),
        b'+' => (false, &s[1..]),
        _ => (false, s),
    };
    let value = if unsigned == "Infinity" {
        f64::INFINITY
    } else if is_decimal_literal(unsigned) {
        unsigned.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    };
    if negative { -value } else { value }
}

/// `StrUnsignedDecimalLiteral`: digits with an optional fraction, or a fraction alone, and an
/// optional exponent.
fn is_decimal_literal(s: &str) -> bool {
    let bytes = s.as_bytes();
    let count = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let int = count(0);
    let mut i = int;
    let mut digits = int;
    if bytes.get(i) == Some(&b'.') {
        let frac = count(i + 1);
        digits += frac;
        i += 1 + frac;
    }
    if digits == 0 {
        return false;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp = count(i);
        if exp == 0 {
            return false;
        }
        i += exp;
    }
    i == bytes.len()
}

/// `decodeURIComponent(s)`; `None` for the `URIError` of a malformed escape or UTF-8 sequence.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let value = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
            // `from_str_radix` accepts a leading `+`; a hex pair does not.
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

const URI_RESERVED_AND_HASH: &str = ";/?:@&=+$,#";

/// `decodeURI(s)`: like `decodeURIComponent`, but an escape of a reserved character or `#` stays
/// as written. `None` for the `URIError` of a malformed escape or UTF-8 sequence.
pub fn decode_uri(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    let hex_byte = |at: usize| -> Option<u8> {
        let pair = bytes.get(at + 1..at + 3)?;
        if bytes.get(at) != Some(&b'%') || !pair.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()
    };
    while i < bytes.len() {
        if bytes[i] != b'%' {
            let start = i;
            while i < bytes.len() && bytes[i] != b'%' {
                i += 1;
            }
            out.push_str(&s[start..i]);
            continue;
        }
        let first = hex_byte(i)?;
        if first < 0x80 {
            let c = first as char;
            if URI_RESERVED_AND_HASH.contains(c) {
                out.push_str(&s[i..i + 3]);
            } else {
                out.push(c);
            }
            i += 3;
            continue;
        }
        let n = first.leading_ones() as usize;
        if !(2..=4).contains(&n) {
            return None;
        }
        let mut sequence = vec![first];
        for k in 1..n {
            let b = hex_byte(i + 3 * k)?;
            if b & 0xC0 != 0x80 {
                return None;
            }
            sequence.push(b);
        }
        out.push_str(std::str::from_utf8(&sequence).ok()?);
        i += 3 * n;
    }
    Some(out)
}

/// `encodeURI(s)`: everything but letters, digits, `-_.!~*'()` and the reserved set with `#`.
pub fn encode_uri(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) || URI_RESERVED_AND_HASH.contains(c)
        {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

/// `encodeURIComponent(s)`: everything but letters, digits and `-_.!~*'()`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every expected value below was read from Node 24.

    #[test]
    fn uri_codecs_match_node() {
        assert_eq!(decode_uri("a%20b").as_deref(), Some("a b"));
        assert_eq!(decode_uri("%23x%2Fy").as_deref(), Some("%23x%2Fy"));
        assert_eq!(decode_uri("caf%C3%A9").as_deref(), Some("café"));
        assert_eq!(decode_uri("%E0%A4%A"), None);
        assert_eq!(decode_uri("%zz"), None);
        assert_eq!(encode_uri("a b#c"), "a%20b#c");
        assert_eq!(encode_uri("é/ü?x=1&y=ü"), "%C3%A9/%C3%BC?x=1&y=%C3%BC");
        assert_eq!(
            encode_uri_component("é/ü?x=1&y=ü"),
            "%C3%A9%2F%C3%BC%3Fx%3D1%26y%3D%C3%BC"
        );
    }

    #[test]
    fn trim_uses_the_js_whitespace_set() {
        assert_eq!(trim("\u{feff}\u{a0} a b \u{2028}"), "a b");
        // U+0085 is whitespace to Rust but not to JS.
        assert_eq!(trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
        // U+180E is not whitespace in current ECMAScript.
        assert_eq!(trim("\u{180e}a"), "\u{180e}a");
    }

    #[test]
    fn utf16_len_counts_code_units() {
        assert_eq!(utf16_len("a\u{1f600}b"), 4);
        assert_eq!(utf16_len("\u{e9}"), 1);
        assert_eq!(utf16_len(""), 0);
    }

    #[test]
    fn slice_uses_utf16_bounds() {
        assert_eq!(utf16_slice("abcdef", 1, 4), "bcd");
        assert_eq!(utf16_slice("abc", 2, 200), "c");
        assert_eq!(utf16_slice("a\u{1f600}b", 0, 3), "a\u{1f600}");
        assert_eq!(utf16_slice("a\u{1f600}b", 3, 4), "b");
    }

    #[test]
    fn slice_through_a_surrogate_pair_leaves_a_replacement_character() {
        // JS: "a\u{1f600}b".slice(0, 2) is "a\ud83d", which UTF-8 encodes as "a\u{fffd}".
        assert_eq!(utf16_slice("a\u{1f600}b", 0, 2), "a\u{fffd}");
        assert_eq!(utf16_slice("a\u{1f600}b", 2, 4), "\u{fffd}b");
    }

    #[test]
    fn substr_and_char_at() {
        assert_eq!(utf16_substr("abcdef", 2, 3), "cde");
        assert_eq!(char_at("abc", 1), "b");
        assert_eq!(char_at("abc", 3), "");
    }

    #[test]
    fn split_on_whitespace_runs_keeps_edge_empties() {
        assert_eq!(split_whitespace_runs("a  b\tc"), vec!["a", "b", "c"]);
        assert_eq!(split_whitespace_runs(" a b "), vec!["", "a", "b", ""]);
        assert_eq!(split_whitespace_runs(""), vec![""]);
        assert_eq!(split_whitespace_runs("   "), vec!["", ""]);
        assert_eq!(split_whitespace_runs("a\u{a0}b"), vec!["a", "b"]);
    }

    #[test]
    fn utf16_index_of_counts_code_units() {
        // 'a😀b'.indexOf('b') is 3 in JS, and 'a😀b'.length is 4.
        let text = Utf16Text::new("a\u{1f600}b");
        assert_eq!(text.unit_len(), 4);
        assert_eq!(text.index_of(&utf16_prefix("b", 1)), 3);
        assert_eq!(text.index_of(&utf16_prefix("", 0)), 0);
        assert_eq!(text.index_of(&utf16_prefix("zz", 2)), -1);
        // A prefix cut through a surrogate pair is a lone high surrogate, which still matches.
        assert_eq!(text.index_of(&utf16_prefix("a\u{1f600}", 2)), 0);
        assert_eq!(text.index_of(&[0xd83d]), 1);
    }

    #[test]
    fn splitting_on_a_class_of_runs() {
        let parts = split_runs(", 0 0, 16 ,16", |c| c == ',' || c == ' ');
        assert_eq!(parts, vec!["", "0", "0", "16", "16"]);
    }

    #[test]
    fn lowercasing_matches_js() {
        assert_eq!(to_lower("ΑΣ"), "ας");
        assert_eq!(to_lower("\u{130}"), "i\u{307}");
    }

    #[test]
    fn parse_int_reads_a_decimal_prefix() {
        assert_eq!(parse_int("42px"), Some(42));
        assert_eq!(parse_int("  -7"), Some(-7));
        assert_eq!(parse_int("+3.9"), Some(3));
        assert_eq!(parse_int("x1"), None);
        assert_eq!(parse_int(""), None);
    }

    #[test]
    fn to_number_reads_whole_string_numeric_literals() {
        assert_eq!(to_number(" 12 "), 12.0);
        assert_eq!(to_number(""), 0.0);
        assert_eq!(to_number("0x10"), 16.0);
        assert_eq!(to_number("1e3"), 1000.0);
        assert_eq!(to_number(".5"), 0.5);
        assert_eq!(to_number("-Infinity"), f64::NEG_INFINITY);
        assert!(to_number("3px").is_nan());
        assert!(to_number("1_0").is_nan());
        assert!(to_number("-0x10").is_nan());
        assert!(to_number("inf").is_nan());
    }

    #[test]
    fn parse_float_reads_the_longest_prefix() {
        assert_eq!(parse_float("3.25abc"), Some(3.25));
        assert_eq!(parse_float(".5"), Some(0.5));
        assert_eq!(parse_float("5."), Some(5.0));
        assert_eq!(parse_float("1e3x"), Some(1000.0));
        assert_eq!(parse_float("1e"), Some(1.0));
        assert_eq!(parse_float("-Infinity"), Some(f64::NEG_INFINITY));
        assert_eq!(parse_float("."), None);
        assert_eq!(parse_float("abc"), None);
    }
}
