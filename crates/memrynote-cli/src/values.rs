//! The argument helpers of `apps/cli/src/cli-support.ts:153-193`: `requireFirst`, `parseNumber`
//! and `parseObjectValue`, with JavaScript's `Number(string)` and `JSON.parse` rules.

use serde_json::{Map, Value};

use crate::CliError;

/// `requireFirst`: the first positional, which must not be empty.
pub fn require_first<'a>(positionals: &'a [String], label: &str) -> Result<&'a str, CliError> {
    match positionals.first() {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(format!("Missing {label}").into()),
    }
}

/// `parseNumber`: `fallback` without a value, else `Number(value)`, which must be finite.
pub fn parse_number(value: Option<&str>, fallback: f64) -> Result<f64, CliError> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    let parsed = js_number(value);
    if parsed.is_finite() {
        Ok(parsed)
    } else {
        Err(format!("Invalid number: {value}").into())
    }
}

/// `parseObjectValue`: `parseCliValue(value ?? '')`, which must be a JSON object.
pub fn parse_object_value(
    value: Option<&str>,
    label: &str,
) -> Result<Map<String, Value>, CliError> {
    let value = value.unwrap_or_default();
    // `parseCliValue` turns these into a boolean, null or a number before `JSON.parse` sees them.
    let scalar = matches!(value, "true" | "false" | "null")
        || (!value.is_empty() && js_number(value).is_finite());
    match serde_json::from_str(value) {
        Ok(Value::Object(map)) if !scalar => Ok(map),
        _ => Err(format!("{label} must be a JSON object").into()),
    }
}

/// `Number(string)`: surrounding white space is ignored, an empty string is 0, `0x`, `0o` and
/// `0b` prefixes are integers, `Infinity` takes a sign, and anything else is a decimal literal
/// or `NaN`.
pub fn js_number(text: &str) -> f64 {
    let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if text.is_empty() {
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
        if let Some(digits) = text.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            return digits
                .chars()
                .try_fold(0.0, |total: f64, c| {
                    c.to_digit(radix)
                        .map(|d| total * f64::from(radix) + f64::from(d))
                })
                .unwrap_or(f64::NAN);
        }
    }
    match text.trim_start_matches(['+', '-']) {
        "Infinity" if text.len() - "Infinity".len() <= 1 => {
            if text.starts_with('-') {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            }
        }
        _ if text
            .chars()
            .all(|c| c.is_ascii_digit() || "+-.eE".contains(c))
            && text.chars().any(|c| c.is_ascii_digit()) =>
        {
            text.parse().unwrap_or(f64::NAN)
        }
        _ => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_follow_javascript() {
        for (text, want) in [
            ("", 0.0),
            ("  12 ", 12.0),
            ("1e3", 1000.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("-2", -2.0),
            ("0x10", 16.0),
            ("0b101", 5.0),
            ("-Infinity", f64::NEG_INFINITY),
        ] {
            assert_eq!(js_number(text).to_bits(), want.to_bits(), "{text:?}");
        }
        for text in [
            "true", "1e", "inf", "NaN", "0x", "1_000", "--1", "0x1g", "e5",
        ] {
            assert!(js_number(text).is_nan(), "{text:?}");
        }
    }

    #[test]
    fn only_a_json_object_is_an_object_value() {
        assert!(parse_object_value(Some(r#"{"a":1}"#), "x").is_ok());
        for text in [
            None,
            Some(""),
            Some("[]"),
            Some("null"),
            Some("3"),
            Some("nope"),
        ] {
            assert_eq!(
                parse_object_value(text, "vault config").unwrap_err().0,
                "vault config must be a JSON object"
            );
        }
    }

    #[test]
    fn invalid_numbers_name_the_value() {
        assert_eq!(parse_number(None, 200.0), Ok(200.0));
        assert_eq!(
            parse_number(Some("true"), 200.0).unwrap_err().0,
            "Invalid number: true"
        );
    }
}
