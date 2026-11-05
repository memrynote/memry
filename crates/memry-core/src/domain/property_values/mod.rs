//! A note property's type, and the value Electron's index gives back for it: the rules the
//! properties panel reads a frontmatter value through, and the values a note's synced record
//! carries (`buildNotePushPayload` reads the index). Ports of `resolvePropertyType` and
//! `inferPropertyType` (`vault/property-type.ts`), and of `serializeValue` then
//! `deserializeValue` (`database/queries/notes/query-helpers.ts`), the round trip a value makes
//! through the index's `note_properties.value` text.

use std::cell::Cell;
use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{Map, Number, Value};

use crate::markdown::frontmatter::YamlValue;
use crate::markdown::frontmatter::js::{iso_string, number_to_string};
use crate::markdown::shared::block_colors::js_value::{js_number, js_parse, js_stringify};

/// `PROJECT_PROPERTY_KEY`: the one key whose type is always `project`.
pub const PROJECT_PROPERTY_KEY: &str = "project";

/// `resolvePropertyType`: the reserved `project` key, then a list of `memry://` links (a
/// relation, whatever a definition says), then the definition's type (but a `text` one for a
/// YAML date, which older builds learned), then the value's own.
pub fn property_type(name: &str, value: &YamlValue, defined: Option<&str>) -> String {
    if name == PROJECT_PROPERTY_KEY {
        return "project".to_owned();
    }
    if is_relation(value) {
        return "relation".to_owned();
    }
    match (defined, value) {
        (Some("text"), YamlValue::Date(_)) => "date".to_owned(),
        (Some(defined), _) => defined.to_owned(),
        (None, _) => inferred(value).to_owned(),
    }
}

/// `inferPropertyType` past its `project` and relation checks.
fn inferred(value: &YamlValue) -> &'static str {
    match value {
        YamlValue::Bool(_) => "checkbox",
        YamlValue::Number(_) => "number",
        YamlValue::Date(_) => "date",
        YamlValue::String(text) if is_iso_date(text) => "date",
        YamlValue::String(text) if is_web_url(text) => "url",
        _ => "text",
    }
}

/// `isRelationValue`: a non-empty list of relation links only.
fn is_relation(value: &YamlValue) -> bool {
    let YamlValue::Seq(items) = value else {
        return false;
    };
    !items.is_empty()
        && items.iter().all(|item| match item {
            YamlValue::String(text) => is_relation_uri(text),
            _ => false,
        })
}

/// `parseRelationUri` succeeds: `memry://<kind>/<id>`, a journal's id a `YYYY-MM-DD` day.
fn is_relation_uri(text: &str) -> bool {
    parse_relation_uri(text).is_some()
}

/// `parseRelationUri` (`contracts/relation-uri.ts`): the kind and id of a `memry://<kind>/<id>`
/// relation value, the id in `[A-Za-z0-9_-]+` and a journal's a `YYYY-MM-DD` day.
pub fn parse_relation_uri(text: &str) -> Option<(&str, &str)> {
    const KINDS: [&str; 6] = [
        "note",
        "task",
        "event",
        "external-event",
        "canvas",
        "journal",
    ];
    let (kind, id) = text.strip_prefix("memry://")?.split_once('/')?;
    let id_ok = !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    let day_ok = kind != "journal" || shaped(id, "dddd-dd-dd");
    (KINDS.contains(&kind) && id_ok && day_ok).then_some((kind, id))
}

/// Whether `text` has the shape `pattern` gives, `d` standing for an ASCII digit.
fn shaped(text: &str, pattern: &str) -> bool {
    text.len() == pattern.len()
        && text
            .bytes()
            .zip(pattern.bytes())
            .all(|(byte, want)| match want {
                b'd' => byte.is_ascii_digit(),
                want => byte == want,
            })
}

/// `isISODate`: `YYYY-MM-DD`, optionally with `THH:MM:SS`, `.mmm` and `Z`, that `new Date`
/// reads as a time. It rolls a day past the month's end over into the next month, so only a
/// day past 31 is not one.
fn is_iso_date(text: &str) -> bool {
    let number = |from: usize| text[from..from + 2].parse::<u32>().unwrap_or(99);
    let date = text.get(..10).is_some_and(|day| shaped(day, "dddd-dd-dd"))
        && (1..=12).contains(&number(5))
        && (1..=31).contains(&number(8));
    if !date {
        return false;
    }
    let rest = &text[10..];
    if rest.is_empty() {
        return true;
    }
    let rest = rest.strip_suffix('Z').unwrap_or(rest);
    let (clock, millis) = match rest.len() {
        9 => (rest, ""),
        13 => rest.split_at(9),
        _ => return false,
    };
    if !shaped(clock, "Tdd:dd:dd") || !(millis.is_empty() || shaped(millis, ".ddd")) {
        return false;
    }
    let (hour, minute, second) = (number(11), number(14), number(17));
    let end_of_day =
        hour == 24 && minute == 0 && second == 0 && millis.trim_matches(['.', '0']).is_empty();
    (hour < 24 || end_of_day) && minute < 60 && second < 60
}

/// `isURL`: an `http:` or `https:` URL.
fn is_web_url(text: &str) -> bool {
    url::Url::parse(text).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

/// One property as the index holds it: its name, its type, its `note_properties.value` text
/// (`serializeValue`) and the value that text reads back as.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedProperty {
    pub name: String,
    pub type_name: String,
    pub text: Option<String>,
    pub value: Value,
}

/// The properties `properties` (a frontmatter's user keys, in order) as the index gives them
/// back, `defined` naming each one's definition type. A value reads as its round trip through
/// the index's text ([`indexed_value`]).
///
/// An alias expands as js-yaml loads it, so `b: *a` and `[*a, *a]` read as Electron reads them.
/// Only a repeat costs: each node of a collection met again (an alias) draws on one budget for
/// the whole note, [`ALIAS_NODES_PER_NODE`] times the nodes the values hold without their
/// repeats, plus [`ALIAS_NODES_BASE`]. A value that runs out reads as `null`, so a few lines
/// of nested aliases cannot stand for gigabytes. A value with no alias in it, such as one the
/// user just set, never draws on the budget.
pub fn indexed_properties<'a>(
    properties: impl IntoIterator<Item = (&'a str, &'a YamlValue)>,
    defined: impl Fn(&str) -> Option<String>,
) -> Vec<IndexedProperty> {
    let properties: Vec<(&str, &YamlValue)> = properties.into_iter().collect();
    let mut walk = Walk::over(properties.iter().map(|(_, value)| *value));
    properties
        .into_iter()
        .map(|(name, value)| {
            let type_name = property_type(name, value, defined(name).as_deref());
            let text = serialized(value, &mut walk);
            let value = text
                .clone()
                .map_or(Value::Null, |text| indexed_value(text, &type_name));
            IndexedProperty {
                name: name.to_owned(),
                type_name,
                text,
                value,
            }
        })
        .collect()
}

/// The alias budget's nodes per node of the values without their repeats, as the size bound of
/// the untrusted-input tests allows eight bytes out per byte in.
pub const ALIAS_NODES_PER_NODE: usize = 8;
/// The alias budget's nodes on top, for a note with few values.
pub const ALIAS_NODES_BASE: usize = 64;

/// Whether `value` expands within the alias budget [`indexed_properties`] gives a note of this
/// one value: a caller about to convert a value whole asks this first.
pub fn expands_within_alias_budget(value: &YamlValue) -> bool {
    json_of(value, &mut Walk::over(std::iter::once(value)), false).is_some()
}

/// The collections met so far, and the nodes repeats may still expand.
struct Walk {
    seen: HashSet<usize>,
    budget: usize,
}

impl Walk {
    fn over<'a>(values: impl Iterator<Item = &'a YamlValue>) -> Self {
        Self {
            seen: HashSet::new(),
            budget: ALIAS_NODES_PER_NODE
                .saturating_mul(distinct_nodes(values))
                .saturating_add(ALIAS_NODES_BASE),
        }
    }
}

/// The nodes of `values` with each collection counted once however many aliases name it: the
/// values, and the items and entries of every distinct collection. Iterative, so any depth is
/// safe.
fn distinct_nodes<'a>(values: impl Iterator<Item = &'a YamlValue>) -> usize {
    let mut seen = HashSet::new();
    let mut stack: Vec<&YamlValue> = values.collect();
    let mut nodes = stack.len();
    while let Some(value) = stack.pop() {
        let children: Vec<&YamlValue> = match value {
            YamlValue::Seq(items) if seen.insert(Arc::as_ptr(items) as usize) => {
                items.iter().collect()
            }
            YamlValue::Map(map) if seen.insert(Arc::as_ptr(map) as *const u8 as usize) => {
                map.iter().map(|(_, value)| value).collect()
            }
            _ => continue,
        };
        nodes += children.len();
        stack.extend(children);
    }
    nodes
}

/// `deserializeValue` of the index's text by the type: a number that is not one reads as
/// `null`, a list type takes a lone value as a one-item list.
fn indexed_value(text: String, type_name: &str) -> Value {
    match type_name {
        "number" => number(js_number(&text)),
        "checkbox" => Value::Bool(text == "true"),
        "multiselect" | "relation" | "project" => match js_parse(&text) {
            Some(Value::Array(items)) => Value::Array(items),
            _ => Value::Array(vec![Value::String(text)]),
        },
        _ => Value::String(text),
    }
}

/// `serializeValue`: `None` for `null`, and for a collection whose aliases ran out of budget.
fn serialized(value: &YamlValue, walk: &mut Walk) -> Option<String> {
    Some(match value {
        YamlValue::Null => return None,
        YamlValue::String(text) => text.clone(),
        YamlValue::Number(x) => number_to_string(*x),
        YamlValue::Bool(b) => b.to_string(),
        YamlValue::Date(ms) => spelled_date(*ms),
        other => js_stringify(&json_of(other, walk, false)?),
    })
}

thread_local! {
    static VISITS: Cell<usize> = const { Cell::new(0) };
}

/// Values [`indexed_properties`] has turned into JSON on this thread, for tests that bound its
/// work by steps rather than by the clock.
#[doc(hidden)]
pub fn json_visits() -> usize {
    VISITS.with(Cell::get)
}

/// `spellYamlDate`: `2026-10-07` at UTC midnight, else the ISO timestamp.
fn spelled_date(ms: i64) -> String {
    let iso = iso_string(ms);
    iso.strip_suffix("T00:00:00.000Z")
        .map_or_else(|| iso.clone(), str::to_owned)
}

/// The value as `JSON.stringify` sees it: a date as its ISO text (`Date#toJSON`), bytes as a
/// `Buffer`'s JSON, a number that is not finite as `null`. `repeat` when the value is inside a
/// collection met before; a collection met again starts a repeat. A repeat's every node draws
/// on the budget, and `None` once the budget is spent.
fn json_of(value: &YamlValue, walk: &mut Walk, repeat: bool) -> Option<Value> {
    VISITS.with(|visits| visits.set(visits.get() + 1));
    let repeat = repeat
        || match value {
            YamlValue::Seq(items) => !walk.seen.insert(Arc::as_ptr(items) as usize),
            YamlValue::Map(map) => !walk.seen.insert(Arc::as_ptr(map) as *const u8 as usize),
            _ => false,
        };
    if repeat {
        walk.budget = walk.budget.checked_sub(1)?;
    }
    Some(match value {
        YamlValue::Null => Value::Null,
        YamlValue::Bool(b) => Value::Bool(*b),
        YamlValue::Number(x) => Number::from_f64(*x).map_or(Value::Null, Value::Number),
        YamlValue::String(text) => Value::String(text.clone()),
        YamlValue::Date(ms) => Value::String(iso_string(*ms)),
        YamlValue::Binary(bytes) => {
            let mut buffer = Map::new();
            buffer.insert("type".into(), Value::String("Buffer".into()));
            let data = bytes.iter().map(|byte| Value::from(*byte)).collect();
            buffer.insert("data".into(), Value::Array(data));
            Value::Object(buffer)
        }
        YamlValue::Seq(items) => Value::Array(
            items
                .iter()
                .map(|item| json_of(item, walk, repeat))
                .collect::<Option<_>>()?,
        ),
        YamlValue::Map(map) => Value::Object(
            map.iter()
                .map(|(key, value)| Some((key.to_owned(), json_of(value, walk, repeat)?)))
                .collect::<Option<_>>()?,
        ),
    })
}

/// A JavaScript number as the IPC's JSON carries it: integral within 2^53 as an integer, not
/// finite as `null` (`JSON.stringify(NaN)`).
fn number(x: f64) -> Value {
    const SAFE: f64 = 9_007_199_254_740_992.0;
    if x.fract() == 0.0 && x.abs() <= SAFE {
        #[allow(clippy::cast_possible_truncation, reason = "integral and within 2^53")]
        return Value::from(x as i64);
    }
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests;
