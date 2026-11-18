//! zod 4's parse (`zod/v4/core/schemas.js`, version 4.3.6), run over the JSON Schema zod printed
//! for the schema (`z.toJSONSchema`, `io: "input"`). The contract files carry the JSON Schema, and
//! Electron answers with zod's issues, so this walk reproduces them: the same verdict, the same
//! issues in the same order, the same `en` messages.
//!
//! What JSON Schema cannot say, the walk reads as zod prints it: `anyOf` of a schema and
//! `{"type":"null"}` is `.nullable()`, `oneOf` is a discriminated union, `prefixItems` is a tuple,
//! `propertyNames` is a record, `additionalProperties: false` is `strictDeep`'s strict object.
//! A schema zod could not print (`z.custom`, unrepresentable as `{}`) takes any value.
//! [`lint`] refuses a keyword the walk does not know, so a new kind of schema fails the catalogue
//! tests instead of passing unchecked.

mod format;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use serde_json::{Map, Value};

use super::refine::{self, Refinement};
pub(super) use format::{dot_path, js_json, js_number, js_prefix, js_quoted_prefix, primitive};

/// zod recurses without a limit; past this many levels of arrays and objects the walk refuses the
/// value instead of growing the stack. serde_json's parse stops at 128, so only a value built in
/// process reaches it.
pub(super) const MAX_DEPTH: usize = 128;
const DEPTH_MESSAGE: &str = "Invalid input: nested deeper than 128 levels";

/// Issues kept per schema node. The rest are counted, so a reply can say how many it left out,
/// without holding one issue per item of a huge wrong array.
pub(super) const KEPT_ISSUES: usize = 100;

const UNKNOWN_KEYS: &str = "Remove it; this call takes only the arguments in its schema.";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Seg {
    Key(String),
    Index(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Code {
    InvalidType,
    InvalidValue,
    TooBig,
    TooSmall,
    InvalidFormat,
    UnrecognizedKeys,
    InvalidKey,
    InvalidUnion,
    Custom,
}

#[derive(Debug, Clone)]
pub(super) struct Issue {
    pub code: Code,
    /// From the value the walk started at; the options of a union are relative to the union.
    pub path: Vec<Seg>,
    pub message: String,
    /// zod's `continue`: a failed check lets the checks after it run; a wrong type does not.
    continues: bool,
    /// The allowed values of `invalid_value`.
    pub values: Vec<Value>,
    /// The keys of `unrecognized_keys`.
    pub keys: Vec<String>,
    /// Each option's issues, for `invalid_union`.
    pub union: Vec<Vec<Issue>>,
}

/// The issues of one schema node: the first [`KEPT_ISSUES`], then a count.
#[derive(Debug, Default)]
pub(super) struct Outcome {
    pub issues: Vec<Issue>,
    pub more: usize,
    more_aborts: bool,
}

impl Outcome {
    pub fn is_ok(&self) -> bool {
        self.issues.is_empty() && self.more == 0
    }

    fn push(&mut self, issue: Issue) {
        if self.issues.len() < KEPT_ISSUES {
            self.issues.push(issue);
        } else {
            self.more += 1;
            self.more_aborts |= !issue.continues;
        }
    }

    fn absorb(&mut self, other: Outcome) {
        for issue in other.issues {
            self.push(issue);
        }
        self.more += other.more;
        self.more_aborts |= other.more_aborts;
    }

    /// zod's `util.aborted`: an issue that stops the checks after it.
    fn aborted(&self) -> bool {
        self.more_aborts || self.issues.iter().any(|issue| !issue.continues)
    }
}

/// One parse: the schema root (for `$ref`), the tool whose refinements apply, and the position.
pub(super) struct Walker<'s> {
    root: &'s Value,
    refinements: Vec<&'static Refinement>,
    path: Vec<Seg>,
    depth: usize,
    /// Schema nodes visited, for the complexity tests.
    pub steps: usize,
}

impl<'s> Walker<'s> {
    pub fn new(root: &'s Value, tool: Option<&str>) -> Self {
        Self {
            root,
            refinements: tool.map(refine::for_tool).unwrap_or_default(),
            path: Vec::new(),
            depth: 0,
            steps: 0,
        }
    }

    /// `value` is `None` where JavaScript has `undefined`: a required key that is absent.
    pub fn check(&mut self, node: &'s Value, value: Option<&Value>) -> Outcome {
        self.steps += 1;
        let node = self.resolve(node);
        let Some(schema) = node.as_object() else {
            return Outcome::default();
        };
        if let Some(options) = schema.get("anyOf").and_then(Value::as_array) {
            return self.any_of(options, value);
        }
        if let Some(options) = schema.get("oneOf").and_then(Value::as_array) {
            return self.one_of(options, value);
        }
        let mut out = Outcome::default();
        let literals = match (schema.get("enum"), schema.get("const")) {
            (Some(Value::Array(values)), _) => Some(values.clone()),
            (_, Some(value)) => Some(vec![value.clone()]),
            _ => None,
        };
        if let Some(values) = literals {
            if !value.is_some_and(|value| values.iter().any(|allowed| same(allowed, value))) {
                let message = if values.len() == 1 {
                    format!("Invalid input: expected {}", primitive(&values[0]))
                } else {
                    let joined: Vec<String> = values.iter().map(primitive).collect();
                    format!("Invalid option: expected one of {}", joined.join("|"))
                };
                let mut issue = self.issue(Code::InvalidValue, message, false);
                issue.values = values;
                out.push(issue);
            }
        } else {
            match schema.get("type").and_then(Value::as_str) {
                Some("string") => self.string(schema, value, &mut out),
                Some(kind @ ("number" | "integer")) => {
                    self.number(schema, kind == "integer", value, &mut out)
                }
                Some("boolean") => self.expect(
                    value.is_some_and(Value::is_boolean),
                    "boolean",
                    value,
                    &mut out,
                ),
                Some("null") => {
                    self.expect(value.is_some_and(Value::is_null), "null", value, &mut out)
                }
                Some("array") if is_tuple(schema) => self.tuple(schema, value, &mut out),
                Some("array") => self.array(schema, value, &mut out),
                Some("object") if schema.contains_key("propertyNames") => {
                    self.record(schema, value, &mut out)
                }
                Some("object") => self.object(schema, value, &mut out),
                // `{}`: zod printed a schema it cannot express, such as `z.custom`.
                _ if value.is_none() => {
                    out.push(self.issue(Code::Custom, "Invalid input".into(), true))
                }
                _ => {}
            }
        }
        if let Some(value) = value
            && !out.aborted()
        {
            self.refine(value, &mut out);
        }
        out
    }

    fn resolve(&self, mut node: &'s Value) -> &'s Value {
        for _ in 0..MAX_DEPTH {
            let Some(reference) = node.get("$ref").and_then(Value::as_str) else {
                return node;
            };
            node = resolve_ref(self.root, reference).unwrap_or(&Value::Null);
        }
        node
    }

    fn issue(&self, code: Code, message: String, continues: bool) -> Issue {
        Issue {
            code,
            path: self.path.clone(),
            message,
            continues,
            values: Vec::new(),
            keys: Vec::new(),
            union: Vec::new(),
        }
    }

    fn invalid_type(&self, expected: &str, value: Option<&Value>) -> Issue {
        let message = format!(
            "Invalid input: expected {expected}, received {}",
            received(value)
        );
        self.issue(Code::InvalidType, message, false)
    }

    fn expect(&self, holds: bool, expected: &str, value: Option<&Value>, out: &mut Outcome) {
        if !holds {
            out.push(self.invalid_type(expected, value));
        }
    }

    fn child(&mut self, seg: Seg, node: &'s Value, value: Option<&Value>, out: &mut Outcome) {
        self.path.push(seg);
        if self.depth >= MAX_DEPTH {
            out.push(self.issue(Code::Custom, DEPTH_MESSAGE.into(), false));
        } else {
            self.depth += 1;
            let child = self.check(node, value);
            self.depth -= 1;
            out.absorb(child);
        }
        self.path.pop();
    }

    /// `.nullable()`, or `z.union`: the first option that passes wins; a single option that
    /// failed only its checks speaks for the union; otherwise one `invalid_union`.
    fn any_of(&mut self, options: &'s [Value], value: Option<&Value>) -> Outcome {
        if let [first, second] = options
            && (is_null(first) || is_null(second))
        {
            if value.is_some_and(Value::is_null) {
                return Outcome::default();
            }
            return self.check(if is_null(second) { first } else { second }, value);
        }
        if let [only] = options {
            return self.check(only, value);
        }
        let mut results = Vec::with_capacity(options.len());
        for option in options {
            let result = self.check(option, value);
            if result.is_ok() {
                return result;
            }
            results.push(result);
        }
        let mut open = results.iter().filter(|result| !result.aborted());
        if let (Some(_), None) = (open.next(), open.next()) {
            let index = results.iter().position(|result| !result.aborted());
            return results.swap_remove(index.unwrap_or_default());
        }
        self.invalid_union(results)
    }

    fn invalid_union(&self, results: Vec<Outcome>) -> Outcome {
        let mut issue = self.issue(Code::InvalidUnion, "Invalid input".into(), false);
        let depth = self.path.len();
        issue.union = results
            .into_iter()
            .map(|result| {
                result
                    .issues
                    .into_iter()
                    .map(|issue| relative(issue, depth))
                    .collect()
            })
            .collect();
        let mut out = Outcome::default();
        out.push(issue);
        out
    }

    /// `z.discriminatedUnion`, printed as `oneOf` of objects that share a `const` key ([`lint`]
    /// refuses a `oneOf` without one).
    fn one_of(&mut self, options: &'s [Value], value: Option<&Value>) -> Outcome {
        let mut out = Outcome::default();
        let key = discriminator(options).unwrap_or_default();
        let Some(object) = value.and_then(Value::as_object) else {
            out.push(self.invalid_type("object", value));
            return out;
        };
        let tag = object.get(key);
        let chosen = options.iter().find(|option| {
            tag.is_some_and(|tag| {
                literals_of(&option["properties"][key])
                    .iter()
                    .any(|allowed| same(allowed, tag))
            })
        });
        if let Some(option) = chosen {
            return self.check(option, value);
        }
        self.path.push(Seg::Key(key.to_owned()));
        out.push(self.issue(Code::InvalidUnion, "Invalid input".into(), false));
        self.path.pop();
        out
    }

    fn string(&self, schema: &Map<String, Value>, value: Option<&Value>, out: &mut Outcome) {
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
            let message = match schema.get("format").and_then(Value::as_str) {
                Some("date-time") => "Invalid ISO datetime".to_owned(),
                _ => format!("Invalid string: must match pattern /{pattern}/"),
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
            let message = format!("Too small: expected {origin} to have >={min} {unit}");
            out.push(self.issue(Code::TooSmall, message, true));
        }
        if let Some(max) = schema.get(keys.1).and_then(Value::as_u64)
            && length > max
        {
            let message = format!("Too big: expected {origin} to have <={max} {unit}");
            out.push(self.issue(Code::TooBig, message, true));
        }
    }

    /// `z.number()`; `integer` is `.int()`, whose check stops the rest and whose safe-integer
    /// range zod prints as `minimum`/`maximum`, so those two are not checked again.
    fn number(
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
        let checks: [(&str, fn(f64, f64) -> bool, Code, &str); 4] = [
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

    fn array(&mut self, schema: &'s Map<String, Value>, value: Option<&Value>, out: &mut Outcome) {
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
    fn tuple(&mut self, schema: &'s Map<String, Value>, value: Option<&Value>, out: &mut Outcome) {
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
    fn object(&mut self, schema: &'s Map<String, Value>, value: Option<&Value>, out: &mut Outcome) {
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
    fn record(&mut self, schema: &'s Map<String, Value>, value: Option<&Value>, out: &mut Outcome) {
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

    fn refine(&self, value: &Value, out: &mut Outcome) {
        for refinement in &self.refinements {
            if let Some(message) = refinement.broken_by(&self.path, value) {
                out.push(self.issue(Code::Custom, message.into(), true));
            }
        }
    }
}

fn is_tuple(schema: &Map<String, Value>) -> bool {
    schema.contains_key("prefixItems") || schema.get("items").is_some_and(Value::is_array)
}

fn is_null(schema: &Value) -> bool {
    schema
        .as_object()
        .is_some_and(|schema| schema.len() == 1 && schema.get("type") == Some(&"null".into()))
}

fn relative(mut issue: Issue, depth: usize) -> Issue {
    issue.path.drain(..depth.min(issue.path.len()));
    issue
}

/// zod's `parsedType`.
fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// `Set.has`: numbers compare by value, so `1` and `1.0` are one.
fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        _ => left == right,
    }
}

fn literals_of(node: &Value) -> Vec<Value> {
    match (node.get("const"), node.get("enum")) {
        (Some(value), _) => vec![value.clone()],
        (_, Some(Value::Array(values))) => values.clone(),
        _ => Vec::new(),
    }
}

/// The key every option fixes to literals, which is how zod prints a discriminated union.
fn discriminator(options: &[Value]) -> Option<&str> {
    let first = options.first()?.get("properties")?.as_object()?;
    first.keys().map(String::as_str).find(|key| {
        options
            .iter()
            .all(|option| !literals_of(&option["properties"][*key]).is_empty())
    })
}

pub(super) fn resolve_ref<'s>(root: &'s Value, reference: &str) -> Option<&'s Value> {
    if reference == "#" {
        return Some(root);
    }
    root.get("$defs")?.get(reference.strip_prefix("#/$defs/")?)
}

/// JavaScript's `RegExp` without flags: `\d` is ASCII, which `unicode(false)` matches.
fn regex(pattern: &str) -> Option<Arc<Regex>> {
    static CACHE: LazyLock<Mutex<HashMap<String, Arc<Regex>>>> = LazyLock::new(Mutex::default);
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(regex) = cache.get(pattern) {
        return Some(regex.clone());
    }
    let regex = Arc::new(
        regex::RegexBuilder::new(pattern)
            .unicode(false)
            .build()
            .ok()?,
    );
    cache.insert(pattern.to_owned(), regex.clone());
    Some(regex)
}

const KEYWORDS: &[&str] = &[
    "type",
    "properties",
    "required",
    "additionalProperties",
    "propertyNames",
    "items",
    "additionalItems",
    "prefixItems",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "enum",
    "const",
    "anyOf",
    "oneOf",
    "$ref",
    "$defs",
    "default",
    "description",
    "$schema",
];

/// Refuses a schema the walk would misread: an unknown keyword, a pattern `regex` cannot build,
/// a format other than zod's `date-time` (which zod prints with its pattern), a `$ref` that
/// does not resolve, or a `oneOf` without a discriminator.
pub(super) fn lint(root: &Value) -> Result<(), String> {
    lint_node(root, root, "#")
}

fn lint_node(root: &Value, node: &Value, at: &str) -> Result<(), String> {
    let Some(schema) = node.as_object() else {
        return Err(format!("{at}: a schema is an object"));
    };
    for (key, child) in schema {
        let at = format!("{at}/{key}");
        if !KEYWORDS.contains(&key.as_str()) {
            return Err(format!("{at}: unknown keyword"));
        }
        let checked = match key.as_str() {
            "pattern" if regex(child.as_str().unwrap_or_default()).is_none() => {
                Err("the pattern does not build")
            }
            "format" if child != "date-time" || !schema.contains_key("pattern") => {
                Err("only date-time with its pattern")
            }
            "$ref" if resolve_ref(root, child.as_str().unwrap_or_default()).is_none() => {
                Err("unresolved")
            }
            "oneOf" if discriminator(child.as_array().map_or(&[][..], Vec::as_slice)).is_none() => {
                Err("no discriminator")
            }
            "propertyNames" if child.get("enum").is_some() => Err("an enum-keyed record"),
            _ => Ok(()),
        };
        checked.map_err(|problem| format!("{at}: {problem}"))?;
        match key.as_str() {
            "properties" | "$defs" => {
                for (name, child) in child.as_object().into_iter().flatten() {
                    lint_node(root, child, &format!("{at}/{name}"))?;
                }
            }
            "anyOf" | "oneOf" | "prefixItems" => {
                for (index, child) in child.as_array().into_iter().flatten().enumerate() {
                    lint_node(root, child, &format!("{at}/{index}"))?;
                }
            }
            "items" if child.is_array() => {
                for (index, child) in child.as_array().into_iter().flatten().enumerate() {
                    lint_node(root, child, &format!("{at}/{index}"))?;
                }
            }
            "items" | "additionalItems" | "propertyNames" => lint_node(root, child, &at)?,
            "additionalProperties" if child.is_object() => lint_node(root, child, &at)?,
            _ => {}
        }
    }
    Ok(())
}
