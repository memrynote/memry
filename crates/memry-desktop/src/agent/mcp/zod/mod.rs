//! zod 4's parse (`zod/v4/core/schemas.js`, version 4.3.6), run over the JSON Schema zod printed
//! for the schema (`z.toJSONSchema`, `io: "input"`). The contract files carry the JSON Schema, and
//! Electron answers with zod's issues, so this walk reproduces them: the same verdict, the same
//! issues in the same order, the same `en` messages.
//!
//! What JSON Schema cannot say, the walk reads as zod prints it: `anyOf` of a schema and
//! `{"type":"null"}` is `.nullable()`, `oneOf` is a discriminated union, `prefixItems` is a tuple,
//! `propertyNames` is a record, `additionalProperties: false` is `strictDeep`'s strict object.
//! A schema zod could not print (`z.unknown`, `z.custom`) is `{}` and takes any value. What the
//! print leaves out comes from the contract files beside it: a tool's refinements by value path
//! ([`super::refine`]), a desktop operation's custom messages, refinements and `z.instanceof` by
//! schema node ([`Extra`]). [`lint`] refuses a keyword the walk does not know, so a new kind of
//! schema fails the catalogue tests instead of passing unchecked.

mod format;
mod kinds;
mod lint;
#[cfg(test)]
mod tests;
mod union;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use serde_json::{Map, Value};

use super::refine::{self, Refinement};
pub(super) use format::{dot_path, js_json, js_number, js_prefix, js_quoted_prefix, primitive};
use kinds::is_tuple;
pub(super) use lint::lint;

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

/// A printed check whose message zod's call replaced (`.min(1, "...")`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Check {
    MinLength,
    MaxLength,
    Pattern,
}

/// A zod check the JSON Schema leaves out, which applies at one schema node.
#[derive(Debug)]
pub(super) enum Extra {
    /// The check is printed; its message is not.
    Message(Check, String),
    /// `.refine` or `z.custom`: refused with the message unless the value holds. `undefined`
    /// never holds; zod hands a refinement `undefined` only under `z.custom`, whose checks refuse
    /// it.
    Refine(String, fn(&Value) -> bool),
    /// `z.instanceof(Class)`: zod's `invalid_type` naming the class, which no JSON value is.
    InstanceOf(String),
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
    extras: Vec<(&'s Value, &'s Extra)>,
    path: Vec<Seg>,
    depth: usize,
}

thread_local! {
    static STEPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Schema nodes this thread's walks have visited, for the complexity tests.
#[cfg(test)]
fn steps() -> usize {
    STEPS.with(std::cell::Cell::get)
}

impl<'s> Walker<'s> {
    pub fn new(root: &'s Value, tool: Option<&str>) -> Self {
        Self {
            root,
            refinements: tool.map(refine::for_tool).unwrap_or_default(),
            extras: Vec::new(),
            path: Vec::new(),
            depth: 0,
        }
    }

    /// The checks of `extras`, each at the node its JSON Pointer names in the root.
    pub fn with_extras(mut self, extras: &'s [(String, Extra)]) -> Self {
        let root = self.root;
        self.extras = extras
            .iter()
            .filter_map(|(at, extra)| Some((root.pointer(at)?, extra)))
            .collect();
        self
    }

    fn extras_at<'a>(&'a self, node: &'a Value) -> impl Iterator<Item = &'s Extra> + 'a {
        self.extras
            .iter()
            .filter(move |(at, _)| std::ptr::eq(*at, node))
            .map(|(_, extra)| *extra)
    }

    /// The message zod's call gave `check` at this schema node, if it gave one.
    fn message(&self, schema: &Map<String, Value>, check: Check) -> Option<&'s str> {
        self.extras.iter().find_map(|(at, extra)| match extra {
            Extra::Message(kind, message)
                if *kind == check && at.as_object().is_some_and(|at| std::ptr::eq(at, schema)) =>
            {
                Some(message.as_str())
            }
            _ => None,
        })
    }

    /// `value` is `None` where JavaScript has `undefined`: a required key that is absent.
    pub fn check(&mut self, node: &'s Value, value: Option<&Value>) -> Outcome {
        STEPS.with(|steps| steps.set(steps.get().wrapping_add(1)));
        let node = self.resolve(node);
        let Some(schema) = node.as_object() else {
            return Outcome::default();
        };
        let mut out = match (schema.get("anyOf"), schema.get("oneOf")) {
            (Some(Value::Array(options)), _) => self.any_of(options, value),
            (_, Some(Value::Array(options))) => self.one_of(options, value),
            _ => {
                let mut out = Outcome::default();
                self.typed(node, schema, value, &mut out);
                if let Some(value) = value
                    && !out.aborted()
                {
                    self.refine(value, &mut out);
                }
                out
            }
        };
        for extra in self.extras_at(node) {
            if let Extra::Refine(message, holds) = extra
                && !out.aborted()
                && !value.is_some_and(|value| holds(value))
            {
                out.push(self.issue(Code::Custom, message.clone(), true));
            }
        }
        out
    }

    /// A node that is not a union: a literal, a typed node, or `{}`.
    fn typed(
        &mut self,
        node: &'s Value,
        schema: &'s Map<String, Value>,
        value: Option<&Value>,
        out: &mut Outcome,
    ) {
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
                Some("string") => self.string(schema, value, out),
                Some(kind @ ("number" | "integer")) => {
                    self.number(schema, kind == "integer", value, out)
                }
                Some("boolean") => {
                    self.expect(value.is_some_and(Value::is_boolean), "boolean", value, out)
                }
                Some("null") => self.expect(value.is_some_and(Value::is_null), "null", value, out),
                Some("array") if is_tuple(schema) => self.tuple(schema, value, out),
                Some("array") => self.array(schema, value, out),
                Some("object") if schema.contains_key("propertyNames") => {
                    self.record(schema, value, out)
                }
                Some("object") => self.object(schema, value, out),
                // `{}`: a schema zod cannot print, which takes `undefined` too.
                _ => {
                    for extra in self.extras_at(node) {
                        if let Extra::InstanceOf(class) = extra {
                            out.push(self.invalid_type(class, value));
                        }
                    }
                }
            }
        }
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

    fn refine(&self, value: &Value, out: &mut Outcome) {
        for refinement in &self.refinements {
            if let Some(message) = refinement.broken_by(&self.path, value) {
                out.push(self.issue(Code::Custom, message.into(), true));
            }
        }
    }
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
