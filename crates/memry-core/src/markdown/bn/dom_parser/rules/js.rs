//! The JavaScript conversions the parse rules read attributes through.

use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim, parse_float};

/// `Number(text)` for a string: `StringToNumber`.
pub fn js_number(text: &str) -> f64 {
    let t = js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if is_decimal_literal(unsigned) {
        // The whole string is a decimal literal, so the longest-prefix parse
        // `parseFloat` does reads all of it.
        return parse_float(t);
    }
    f64::NAN
}

/// `StrUnsignedDecimalLiteral` without `Infinity`.
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
        let mut probe = at + 1;
        if matches!(bytes.get(probe), Some(b'+' | b'-')) {
            probe += 1;
        }
        let exp = digits(probe);
        if exp == 0 {
            return false;
        }
        at = probe + exp;
    }
    at == bytes.len()
}

/// `parseInt(text, 10)` and `parseInt(text)` for text without a hex prefix.
pub fn js_parse_int(text: &str) -> f64 {
    let t = text.trim_start_matches(is_js_whitespace);
    let (negative, rest) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let (radix, digits) = match rest.strip_prefix("0x").or_else(|| rest.strip_prefix("0X")) {
        Some(hex) => (16, hex),
        None => (10, rest),
    };
    let value = crate::markdown::frontmatter::js::parse_int(digits, radix);
    if negative { -value } else { value }
}

/// `Math.round(x)`: halves round towards positive infinity.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// tiptap's `fromString` applied to an attribute value: a numeric string
/// becomes a number, `"true"` and `"false"` booleans.
pub fn from_string(value: &str) -> yrs::Any {
    let unsigned = value.strip_prefix(['+', '-']).unwrap_or(value);
    let numeric = match unsigned.split_once('.') {
        Some((int, frac)) => {
            int.bytes().all(|b| b.is_ascii_digit())
                && !frac.is_empty()
                && frac.bytes().all(|b| b.is_ascii_digit())
        }
        None => !unsigned.is_empty() && unsigned.bytes().all(|b| b.is_ascii_digit()),
    };
    if numeric {
        return yrs::Any::Number(parse_float(value));
    }
    match value {
        "true" => yrs::Any::Bool(true),
        "false" => yrs::Any::Bool(false),
        _ => yrs::Any::from(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::Any;

    #[test]
    fn number_follows_string_to_number() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number("  12 "), 12.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e3"), 1000.0);
        assert_eq!(js_number(".5"), 0.5);
        assert!(js_number("12px").is_nan());
        assert!(js_number("1e").is_nan());
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
    }

    #[test]
    fn round_and_parse_int() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_parse_int(" 42px"), 42.0);
        assert_eq!(js_parse_int("-7"), -7.0);
        assert!(js_parse_int("x").is_nan());
    }

    #[test]
    fn from_string_matches_tiptap() {
        assert_eq!(from_string("3"), Any::Number(3.0));
        assert_eq!(from_string("-1.5"), Any::Number(-1.5));
        assert_eq!(from_string(".5"), Any::Number(0.5));
        assert_eq!(from_string("5."), Any::from("5."));
        assert_eq!(from_string("true"), Any::Bool(true));
        assert_eq!(from_string("2x"), Any::from("2x"));
        assert_eq!(from_string(""), Any::from(""));
    }
}
