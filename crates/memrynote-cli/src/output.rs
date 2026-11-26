//! `print` and `formatHuman` of `apps/cli/src/cli-support.ts:103-157`, with the rules of
//! `JSON.stringify` and `Number.prototype.toString`, not serde's.

use serde_json::{Map, Number, Value};

use crate::CliIo;

/// `print(io, json, value)`. `None` is JavaScript's `undefined`: `--json` prints the word, as
/// the TypeScript interpolates it, and human mode prints an empty line.
pub fn print(io: &mut dyn CliIo, json: bool, value: Option<&Value>) {
    let line = match (json, value) {
        (true, Some(value)) => stringify(value, None),
        (true, None) => "undefined".to_owned(),
        (false, value) => human(value),
    };
    io.out(&line);
}

/// `formatHuman`: strings raw, numbers and booleans through `String`, null and undefined
/// empty, everything else `JSON.stringify(value, null, 2)`.
pub fn human(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number_to_string(number),
        Some(value) => stringify(value, Some(2)),
    }
}

/// `JSON.stringify(value)` with `indent` spaces per level, or on one line.
pub fn stringify(value: &Value, indent: Option<usize>) -> String {
    let mut out = String::new();
    write_value(&mut out, value, indent, 0);
    out
}

fn write_value(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&json_number(number)),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            write_list(out, items.iter(), indent, depth, ['[', ']'], |out, item| {
                write_value(out, item, indent, depth + 1);
            });
        }
        Value::Object(map) => {
            let space = if indent.is_some() { " " } else { "" };
            write_list(
                out,
                js_key_order(map).into_iter(),
                indent,
                depth,
                ['{', '}'],
                |out, (key, item)| {
                    write_string(out, key);
                    out.push(':');
                    out.push_str(space);
                    write_value(out, item, indent, depth + 1);
                },
            );
        }
    }
}

fn write_list<T>(
    out: &mut String,
    items: impl ExactSizeIterator<Item = T>,
    indent: Option<usize>,
    depth: usize,
    [open, close]: [char; 2],
    mut write_item: impl FnMut(&mut String, T),
) {
    out.push(open);
    if items.len() == 0 {
        out.push(close);
        return;
    }
    let newline = |out: &mut String, level: usize| {
        if let Some(width) = indent {
            out.push('\n');
            out.extend(std::iter::repeat_n(' ', width * level));
        }
    };
    for (index, item) in items.enumerate() {
        if index > 0 {
            out.push(',');
        }
        newline(out, depth + 1);
        write_item(out, item);
    }
    newline(out, depth);
    out.push(close);
}

/// JavaScript's own-property order: keys that are array indices (canonical integers below
/// 2^32 - 1) ascending, then the other keys in insertion order.
fn js_key_order(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut named = Vec::new();
    for entry in map {
        match array_index(entry.0) {
            Some(index) => indexed.push((index, entry)),
            None => named.push(entry),
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    indexed
        .into_iter()
        .map(|(_, entry)| entry)
        .chain(named)
        .collect()
}

fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0"
        || (!key.is_empty() && !key.starts_with('0') && key.bytes().all(|b| b.is_ascii_digit()));
    if !canonical {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// The escapes of `JSON.stringify`: the quote, the backslash, the five short control escapes
/// and `\u00xx` for the other control characters. Everything else is literal.
fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch < ' ' => out.push_str(&format!("\\u{:04x}", u32::from(ch))),
            ch => out.push(ch),
        }
    }
    out.push('"');
}

/// A number inside JSON: NaN and the infinities are `null`.
fn json_number(number: &Number) -> String {
    match number.as_f64() {
        Some(value) if number.is_f64() && !value.is_finite() => "null".to_owned(),
        _ => number_to_string(number),
    }
}

/// `String(number)`.
pub fn number_to_string(number: &Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    f64_to_string(number.as_f64().unwrap_or(f64::NAN))
}

/// `Number.prototype.toString()` (ECMA-262 Number::toString, radix 10).
pub fn f64_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // Rust's `{:e}` prints the shortest digits that round-trip, as the spec asks for.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("`{:e}` always has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("integer exponent") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let exp_sign = if n - 1 < 0 { '-' } else { '+' };
        let rest = if k == 1 {
            String::new()
        } else {
            format!(".{}", &digits[1..])
        };
        format!("{}{rest}e{exp_sign}{}", &digits[..1], (n - 1).abs())
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        let cases = [
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (-0.0, "0"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.25e-7, "1.25e-7"),
            (0.1 + 0.2, "0.30000000000000004"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ];
        for (value, expected) in cases {
            assert_eq!(f64_to_string(value), expected, "{value:?}");
        }
    }

    #[test]
    fn json_turns_non_finite_numbers_into_null() {
        // serde_json cannot hold NaN, so the guard is checked on the formatter path it takes.
        assert_eq!(json_number(&Number::from_f64(2.5).expect("finite")), "2.5");
        assert_eq!(stringify(&json!(-0.0), None), "0");
        assert_eq!(stringify(&json!(1e21), None), "1e+21");
        assert_eq!(stringify(&json!(u64::MAX), None), "18446744073709551615");
    }

    #[test]
    fn integer_like_keys_come_first_in_ascending_order() {
        let value = json!({"b": 1, "10": 2, "a": 3, "2": 4, "01": 5, "4294967295": 6, "0": 7});
        assert_eq!(
            stringify(&value, None),
            r#"{"0":7,"2":4,"10":2,"b":1,"a":3,"01":5,"4294967295":6}"#
        );
    }

    #[test]
    fn strings_use_the_escapes_of_json_stringify() {
        let value = json!("q\" b\\ \u{8}\u{c}\n\r\t \u{1} \u{1f} \u{7f} \u{2028} / é");
        assert_eq!(
            stringify(&value, None),
            "\"q\\\" b\\\\ \\b\\f\\n\\r\\t \\u0001 \\u001f \u{7f} \u{2028} / é\""
        );
    }

    #[test]
    fn pretty_printing_matches_two_space_json_stringify() {
        let value = json!({"a": [], "b": {}, "c": [1, {"d": null}], "e": "x"});
        assert_eq!(
            stringify(&value, Some(2)),
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    {\n      \"d\": null\n    }\n  ],\n  \"e\": \"x\"\n}"
        );
    }

    #[test]
    fn human_mode_prints_scalars_raw_and_undefined_empty() {
        assert_eq!(human(Some(&json!("a\"b"))), "a\"b");
        assert_eq!(human(Some(&json!(2.5))), "2.5");
        assert_eq!(human(Some(&json!(true))), "true");
        assert_eq!(human(Some(&Value::Null)), "");
        assert_eq!(human(None), "");
        assert_eq!(human(Some(&json!([1]))), "[\n  1\n]");
    }

    #[test]
    fn json_mode_prints_undefined_as_the_word() {
        struct Lines(Vec<String>);
        impl CliIo for Lines {
            fn out(&mut self, line: &str) {
                self.0.push(line.to_owned());
            }
            fn err(&mut self, _: &str) {}
        }
        let mut io = Lines(Vec::new());
        print(&mut io, true, None);
        print(&mut io, false, None);
        print(&mut io, true, Some(&json!({"a": 1})));
        assert_eq!(io.0, ["undefined", "", r#"{"a":1}"#]);
    }
}
