//! The typed nodes: `z.string`, `z.number`, `z.array`, `z.tuple`, `z.object` and `z.record`.

use std::sync::LazyLock;

use serde_json::{Map, Value};

use super::{Check, Code, MAX_SAFE_INTEGER, Outcome, Seg, UNKNOWN_KEYS, Walker, js_number, regex};

impl<'s> Walker<'s> {
    pub(super) fn string(
        &self,
        schema: &Map<String, Value>,
        value: Option<&Value>,
        out: &mut Outcome,
    ) {
        let text = value.and_then(Value::as_str);
        if text.is_none() {
            out.push(self.invalid_type("string", value));
        }
        self.lengths(schema, value, ("minLength", "maxLength"), out);
        if let Some(text) = text
            && !out.aborted()
            && let Some(pattern) = schema.get("pattern").and_then(Value::as_str)
            && !regex(pattern).is_some_and(|regex| regex.is_match(text))
        {
            let message = match (self.message(schema, Check::Pattern), schema.get("format")) {
                (Some(message), _) => message.to_owned(),
                (None, Some(format)) if format == "date-time" => "Invalid ISO datetime".to_owned(),
                (None, _) => format!("Invalid string: must match pattern /{pattern}/"),
            };
            out.push(self.issue(Code::InvalidFormat, message, true));
        }
    }

    /// zod's length checks, which run on anything with a `length` (`def.when`), even after a
    /// wrong type: a string for `z.array().min(1)` is too short in characters.
    fn lengths(
        &self,
        schema: &Map<String, Value>,
        value: Option<&Value>,
        keys: (&str, &str),
        out: &mut Outcome,
    ) {
        let (length, origin, unit) = match value {
            Some(Value::String(text)) => {
                (text.encode_utf16().count() as u64, "string", "characters")
            }
            Some(Value::Array(items)) => (items.len() as u64, "array", "items"),
            _ => return,
        };
        if let Some(min) = schema.get(keys.0).and_then(Value::as_u64)
            && length < min
        {
            let message = self.message(schema, Check::MinLength).map_or_else(
                || format!("Too small: expected {origin} to have >={min} {unit}"),
                str::to_owned,
            );
            out.push(self.issue(Code::TooSmall, message, true));
        }
        if let Some(max) = schema.get(keys.1).and_then(Value::as_u64)
            && length > max
        {
            let message = self.message(schema, Check::MaxLength).map_or_else(
                || format!("Too big: expected {origin} to have <={max} {unit}"),
                str::to_owned,
            );
            out.push(self.issue(Code::TooBig, message, true));
        }
    }

    /// `z.number()`; `integer` is `.int()`, whose check stops the rest and whose safe-integer
    /// range zod prints as `minimum`/`maximum`, so those two are not checked again.
    pub(super) fn number(
        &self,
        schema: &Map<String, Value>,
        integer: bool,
        value: Option<&Value>,
        out: &mut Outcome,
    ) {
        let Some(number) = value.and_then(Value::as_f64) else {
            out.push(self.invalid_type("number", value));
            return;
        };
        if integer {
            if number.fract() != 0.0 {
                out.push(self.invalid_type("int", value));
                return;
            }
            if number.abs() > MAX_SAFE_INTEGER {
                let (code, message) = if number > 0.0 {
                    (
                        Code::TooBig,
                        "Too big: expected int to be <=9007199254740991",
                    )
                } else {
                    (
                        Code::TooSmall,
                        "Too small: expected int to be >=-9007199254740991",
                    )
                };
                out.push(self.issue(code, message.into(), true));
            }
        }
        let bound = |key: &str| {
            schema.get(key).and_then(Value::as_number).filter(|bound| {
                !(integer && bound.as_f64().is_some_and(|b| b.abs() == MAX_SAFE_INTEGER))
            })
        };
        type Bound = (&'static str, fn(f64, f64) -> bool, Code, &'static str);
        let checks: [Bound; 4] = [
            (
                "minimum",
                |n, b| n < b,
                Code::TooSmall,
                "Too small: expected number to be >=",
            ),
            (
                "exclusiveMinimum",
                |n, b| n <= b,
                Code::TooSmall,
                "Too small: expected number to be >",
            ),
            (
                "maximum",
                |n, b| n > b,
                Code::TooBig,
                "Too big: expected number to be <=",
            ),
            (
                "exclusiveMaximum",
                |n, b| n >= b,
                Code::TooBig,
                "Too big: expected number to be <",
            ),
        ];
        for (key, breaks, code, text) in checks {
            if let Some(limit) = bound(key)
                && breaks(number, limit.as_f64().unwrap_or_default())
            {
                out.push(self.issue(code, format!("{text}{}", js_number(limit)), true));
            }
        }
    }

    pub(super) fn array(
        &mut self,
        schema: &'s Map<String, Value>,
        value: Option<&Value>,
        out: &mut Outcome,
    ) {
        match value.and_then(Value::as_array) {
            None => out.push(self.invalid_type("array", value)),
            Some(items) => {
                if let Some(item_schema) = schema.get("items") {
                    for (index, item) in items.iter().enumerate() {
                        self.child(Seg::Index(index), item_schema, Some(item), out);
                    }
                }
            }
        }
        self.lengths(schema, value, ("minItems", "maxItems"), out);
    }

    /// `z.tuple`: `minItems` is where the optional tail starts (zod's `optStart`), and zod's
    /// too-short test is `length < optStart - 1`, kept as it is.
    pub(super) fn tuple(
        &mut self,
        schema: &'s Map<String, Value>,
        value: Option<&Value>,
        out: &mut Outcome,
    ) {
        let Some(input) = value.and_then(Value::as_array) else {
            out.push(self.invalid_type("tuple", value));
            return;
        };
        // draft 2020-12 prints `prefixItems` and `items`, draft 7 `items` and `additionalItems`.
        let (items, rest) = match schema.get("prefixItems") {
            Some(items) => (items, schema.get("items")),
            None => (&schema["items"], schema.get("additionalItems")),
        };
        let items = items.as_array().map_or(&[][..], Vec::as_slice);
        let count = items.len();
        let opt_start = schema
            .get("minItems")
            .and_then(Value::as_u64)
            .map_or(count, |min| min as usize);
        if rest.is_none() {
            if input.len() > count {
                let message = format!("Too big: expected array to have <={count} items");
                out.push(self.issue(Code::TooBig, message, false));
                return;
            }
            if input.len() + 1 < opt_start {
                let message = format!("Too small: expected array to have >{count} items");
                out.push(self.issue(Code::TooSmall, message, false));
                return;
            }
        }
        for (index, item) in items.iter().enumerate() {
            if index >= input.len() && index >= opt_start {
                continue;
            }
            self.child(Seg::Index(index), item, input.get(index), out);
        }
        if let Some(rest) = rest {
            for (index, item) in input.iter().enumerate().skip(count) {
                self.child(Seg::Index(index), rest, Some(item), out);
            }
        }
    }

    /// `z.object`: each named key in order (an absent optional key is skipped), then the keys it
    /// does not name: refused when strict, checked against the catchall, or dropped.
    pub(super) fn object(
        &mut self,
        schema: &'s Map<String, Value>,
        value: Option<&Value>,
        out: &mut Outcome,
    ) {
        let Some(object) = value.and_then(Value::as_object) else {
            out.push(self.invalid_type("object", value));
            return;
        };
        static NONE: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .unwrap_or(&NONE);
        let required = |key: &str| {
            schema
                .get("required")
                .and_then(Value::as_array)
                .is_some_and(|required| required.iter().any(|name| name == key))
        };
        for (key, property) in properties {
            match object.get(key) {
                Some(present) => self.child(Seg::Key(key.clone()), property, Some(present), out),
                None if required(key) => self.child(Seg::Key(key.clone()), property, None, out),
                None => {}
            }
        }
        let extra = object
            .iter()
            .filter(|(key, _)| !properties.contains_key(*key));
        match schema.get("additionalProperties") {
            Some(Value::Bool(false)) => {
                let keys: Vec<String> = extra.map(|(key, _)| key.clone()).collect();
                if !keys.is_empty() {
                    let message = format!("Unknown argument: {}. {UNKNOWN_KEYS}", keys.join(", "));
                    let mut issue = self.issue(Code::UnrecognizedKeys, message, false);
                    issue.keys = keys;
                    out.push(issue);
                }
            }
            Some(catchall @ Value::Object(_)) => {
                for (key, item) in extra {
                    self.child(Seg::Key(key.clone()), catchall, Some(item), out);
                }
            }
            _ => {}
        }
    }

    /// `z.record` with string keys: a key its schema refuses is one `invalid_key`. Without
    /// `additionalProperties` the values are `z.unknown()`.
    pub(super) fn record(
        &mut self,
        schema: &'s Map<String, Value>,
        value: Option<&Value>,
        out: &mut Outcome,
    ) {
        let Some(object) = value.and_then(Value::as_object) else {
            out.push(self.invalid_type("record", value));
            return;
        };
        for (key, item) in object {
            if key == "__proto__" {
                continue;
            }
            if !self
                .check(&schema["propertyNames"], Some(&Value::String(key.clone())))
                .is_ok()
            {
                self.path.push(Seg::Key(key.clone()));
                out.push(self.issue(Code::InvalidKey, "Invalid key in record".into(), false));
                self.path.pop();
                continue;
            }
            if let Some(values) = schema.get("additionalProperties") {
                self.child(Seg::Key(key.clone()), values, Some(item), out);
            }
        }
    }
}

pub(super) fn is_tuple(schema: &Map<String, Value>) -> bool {
    schema.contains_key("prefixItems") || schema.get("items").is_some_and(Value::is_array)
}
