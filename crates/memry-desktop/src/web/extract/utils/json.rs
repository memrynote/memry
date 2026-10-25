//! `JSON.parse` and `JSON.stringify` over a value that keeps JavaScript's object semantics.
//!
//! JSON-LD goes through JS objects, so key order is the JS own-key order (array-index keys
//! ascending, then the rest in insertion order), a duplicate key keeps its first position with
//! the last value, and numbers are doubles printed by `Number#toString`. `serde_json::Value`
//! does none of that, and it rejects the lone surrogate escapes `JSON.parse` accepts.

/// A JSON value as JavaScript holds it.
#[derive(Debug, Clone, PartialEq)]
pub enum JsValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsValue>),
    /// Own properties in JS enumeration order.
    Object(Vec<(String, JsValue)>),
}

/// Nesting beyond this is a parse error here. V8's limit is higher; a page that nests JSON-LD
/// this deep is not an article, and an unbounded recursion would overflow the stack.
const MAX_DEPTH: usize = 1000;

impl JsValue {
    /// `typeof value === 'object'` for a non-null value: arrays and objects.
    pub fn is_object_like(&self) -> bool {
        matches!(self, JsValue::Array(_) | JsValue::Object(_))
    }

    /// `value[key]` on an object, own properties only.
    pub fn get(&self, key: &str) -> Option<&JsValue> {
        match self {
            JsValue::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsValue::String(s) => Some(s),
            _ => None,
        }
    }

    /// `Boolean(value)`.
    pub fn truthy(&self) -> bool {
        match self {
            JsValue::Null => false,
            JsValue::Bool(b) => *b,
            JsValue::Number(n) => *n != 0.0 && !n.is_nan(),
            JsValue::String(s) => !s.is_empty(),
            JsValue::Array(_) | JsValue::Object(_) => true,
        }
    }

    /// `String(value)`, which `Array#join` applies to each element (`null` joins as empty).
    pub fn to_js_string(&self) -> String {
        match self {
            JsValue::Null => String::new(),
            JsValue::Bool(b) => b.to_string(),
            JsValue::Number(n) => number_to_string(*n),
            JsValue::String(s) => s.clone(),
            JsValue::Array(items) => items
                .iter()
                .map(JsValue::to_js_string)
                .collect::<Vec<_>>()
                .join(","),
            JsValue::Object(_) => "[object Object]".to_string(),
        }
    }

    /// `JSON.stringify(value)` of a parsed value.
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }

    fn write_json(&self, out: &mut String) {
        match self {
            JsValue::Null => out.push_str("null"),
            JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            JsValue::Number(n) if n.is_finite() => out.push_str(&number_to_string(*n)),
            JsValue::Number(_) => out.push_str("null"),
            JsValue::String(s) => write_json_string(s, out),
            JsValue::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write_json(out);
                }
                out.push(']');
            }
            JsValue::Object(entries) => {
                out.push('{');
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_json_string(key, out);
                    out.push(':');
                    value.write_json(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `String(number)` (ECMA-262 `Number::toString`, radix 10).
pub fn number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    if value.is_infinite() {
        return if value < 0.0 { "-Infinity" } else { "Infinity" }.to_string();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // `{:e}` prints the shortest digits that round-trip, like the spec's `k` and `s`.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("exponent form");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("exponent") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign_e = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign_e}{}", e.abs())
        } else {
            format!("{}.{}e{sign_e}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
}

/// `JSON.parse(text)`; `Err` carries a reason where JS throws a `SyntaxError`. A lone surrogate
/// escape becomes U+FFFD because a Rust string cannot hold it.
pub fn parse(text: &str) -> Result<JsValue, String> {
    let mut parser = Parser {
        chars: text.chars().collect(),
        pos: 0,
    };
    parser.skip_whitespace();
    let value = parser.value(0)?;
    parser.skip_whitespace();
    if parser.pos != parser.chars.len() {
        return Err(format!("unexpected token at {}", parser.pos));
    }
    Ok(value)
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    /// JSON whitespace is space, tab, line feed and carriage return only.
    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t' | '\n' | '\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, literal: &str) -> Result<(), String> {
        for expected in literal.chars() {
            if self.peek() != Some(expected) {
                return Err(format!("unexpected token at {}", self.pos));
            }
            self.pos += 1;
        }
        Ok(())
    }

    fn value(&mut self, depth: usize) -> Result<JsValue, String> {
        if depth > MAX_DEPTH {
            return Err("nesting too deep".to_string());
        }
        match self.peek() {
            Some('{') => self.object(depth),
            Some('[') => self.array(depth),
            Some('"') => self.string().map(JsValue::String),
            Some('t') => self.expect("true").map(|()| JsValue::Bool(true)),
            Some('f') => self.expect("false").map(|()| JsValue::Bool(false)),
            Some('n') => self.expect("null").map(|()| JsValue::Null),
            Some('-' | '0'..='9') => self.number(),
            _ => Err(format!("unexpected token at {}", self.pos)),
        }
    }

    fn number(&mut self) -> Result<JsValue, String> {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.pos += 1;
        }
        match self.peek() {
            Some('0') => self.pos += 1,
            Some('1'..='9') => self.digits(),
            _ => return Err(format!("bad number at {}", self.pos)),
        }
        if self.peek() == Some('.') {
            self.pos += 1;
            if !matches!(self.peek(), Some('0'..='9')) {
                return Err(format!("bad number at {}", self.pos));
            }
            self.digits();
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some('+' | '-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some('0'..='9')) {
                return Err(format!("bad number at {}", self.pos));
            }
            self.digits();
        }
        let literal: String = self.chars[start..self.pos].iter().collect();
        literal
            .parse::<f64>()
            .map(JsValue::Number)
            .map_err(|e| e.to_string())
    }

    fn digits(&mut self) {
        while matches!(self.peek(), Some('0'..='9')) {
            self.pos += 1;
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let mut code = 0u32;
        for _ in 0..4 {
            let digit = self
                .peek()
                .and_then(|c| c.to_digit(16))
                .ok_or_else(|| format!("bad escape at {}", self.pos))?;
            code = code * 16 + digit;
            self.pos += 1;
        }
        Ok(code)
    }

    fn string(&mut self) -> Result<String, String> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or("unterminated string")?;
            self.pos += 1;
            match c {
                '"' => return Ok(out),
                '\\' => {
                    let escape = self.peek().ok_or("unterminated string")?;
                    self.pos += 1;
                    match escape {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => {
                            let unit = self.hex4()?;
                            out.push(self.unicode_escape(unit)?);
                        }
                        _ => return Err(format!("bad escape at {}", self.pos)),
                    }
                }
                c if (c as u32) < 0x20 => return Err(format!("control character at {}", self.pos)),
                c => out.push(c),
            }
        }
    }

    /// Joins `\uD83D\uDE00` into one scalar; a lone half becomes U+FFFD.
    fn unicode_escape(&mut self, unit: u32) -> Result<char, String> {
        if (0xD800..0xDC00).contains(&unit)
            && self.peek() == Some('\\')
            && self.chars.get(self.pos + 1) == Some(&'u')
        {
            let save = self.pos;
            self.pos += 2;
            let low = self.hex4()?;
            if (0xDC00..0xE000).contains(&low) {
                let scalar = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
                return Ok(char::from_u32(scalar).unwrap_or('\u{fffd}'));
            }
            self.pos = save;
        }
        Ok(char::from_u32(unit).unwrap_or('\u{fffd}'))
    }

    fn array(&mut self, depth: usize) -> Result<JsValue, String> {
        self.pos += 1;
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(']') {
            self.pos += 1;
            return Ok(JsValue::Array(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.value(depth + 1)?);
            self.skip_whitespace();
            match self.peek() {
                Some(',') => self.pos += 1,
                Some(']') => {
                    self.pos += 1;
                    return Ok(JsValue::Array(items));
                }
                _ => return Err(format!("unexpected token at {}", self.pos)),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<JsValue, String> {
        self.pos += 1;
        let mut entries: Vec<(String, JsValue)> = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some('}') {
            self.pos += 1;
            return Ok(JsValue::Object(entries));
        }
        loop {
            self.skip_whitespace();
            if self.peek() != Some('"') {
                return Err(format!("unexpected token at {}", self.pos));
            }
            let key = self.string()?;
            self.skip_whitespace();
            if self.peek() != Some(':') {
                return Err(format!("unexpected token at {}", self.pos));
            }
            self.pos += 1;
            self.skip_whitespace();
            let value = self.value(depth + 1)?;
            // A repeated key keeps its first position and takes the last value.
            match entries.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = value,
                None => entries.push((key, value)),
            }
            self.skip_whitespace();
            match self.peek() {
                Some(',') => self.pos += 1,
                Some('}') => {
                    self.pos += 1;
                    return Ok(JsValue::Object(order_keys(entries)));
                }
                _ => return Err(format!("unexpected token at {}", self.pos)),
            }
        }
    }
}

/// A canonical array index: `0` or digits without a leading zero, below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    key.parse::<u64>()
        .ok()
        .filter(|n| *n < u64::from(u32::MAX))
        .map(|n| n as u32)
}

/// `OrdinaryOwnPropertyKeys`: integer keys ascending, then string keys in insertion order.
fn order_keys(entries: Vec<(String, JsValue)>) -> Vec<(String, JsValue)> {
    if !entries.iter().any(|(k, _)| array_index(k).is_some()) {
        return entries;
    }
    let (mut indexed, named): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .partition(|(k, _)| array_index(k).is_some());
    indexed.sort_by_key(|(k, _)| array_index(k));
    indexed.extend(named);
    indexed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_formatting_follows_ecmascript() {
        for (value, text) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-12.5, "-12.5"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (1.5e300, "1.5e+300"),
            (0.1 + 0.2, "0.30000000000000004"),
            (f64::INFINITY, "Infinity"),
        ] {
            assert_eq!(number_to_string(value), text);
        }
    }

    #[test]
    fn objects_order_index_keys_first_and_keep_first_duplicate_position() {
        let value = parse(r#"{"b":1,"2":2,"a":3,"1":4,"b":5,"01":6}"#).unwrap();
        assert_eq!(value.stringify(), r#"{"1":4,"2":2,"b":5,"a":3,"01":6}"#);
    }

    #[test]
    fn strings_and_errors() {
        assert_eq!(
            parse(r#"["\ud83d\ude00","\ud800x","\u00e9\n"]"#)
                .unwrap()
                .stringify(),
            "[\"\u{1f600}\",\"\u{fffd}x\",\"\u{e9}\\n\"]"
        );
        for bad in [
            "", "{", "[1,]", "{'a':1}", "01", "1.", "\"\t\"", "nul", "[1] x", "\u{a0}1",
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            parse(" \n[1e3, -0, 2E-2]\t").unwrap().stringify(),
            "[1000,0,0.02]"
        );
    }
}
