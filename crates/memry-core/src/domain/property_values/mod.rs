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
    const KINDS: [&str; 6] = [
        "note",
        "task",
        "event",
        "external-event",
        "canvas",
        "journal",
    ];
    let Some((kind, id)) = text
        .strip_prefix("memry://")
        .and_then(|rest| rest.split_once('/'))
    else {
        return false;
    };
    let id_ok = !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    let day_ok = kind != "journal" || shaped(id, "dddd-dd-dd");
    KINDS.contains(&kind) && id_ok && day_ok
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

/// One property as the index holds it: its name, its type and its value.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedProperty {
    pub name: String,
    pub type_name: String,
    pub value: Value,
}

/// The properties `properties` (a frontmatter's user keys, in order) as the index gives them
/// back, `defined` naming each one's definition type. A value reads as its round trip through
/// the index's text ([`indexed_value`]). A list or a map that an alias already brought in once
/// reads as `null`: expanding it again would let a few lines of aliases stand for gigabytes.
pub fn indexed_properties<'a>(
    properties: impl IntoIterator<Item = (&'a str, &'a YamlValue)>,
    defined: impl Fn(&str) -> Option<String>,
) -> Vec<IndexedProperty> {
    let mut seen = HashSet::new();
    properties
        .into_iter()
        .map(|(name, value)| {
            let type_name = property_type(name, value, defined(name).as_deref());
            let value = serialized(value, &mut seen)
                .map_or(Value::Null, |text| indexed_value(text, &type_name));
            IndexedProperty {
                name: name.to_owned(),
                type_name,
                value,
            }
        })
        .collect()
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

/// `serializeValue`: `None` for `null`, and for a collection an alias brought in before.
fn serialized(value: &YamlValue, seen: &mut HashSet<usize>) -> Option<String> {
    Some(match value {
        YamlValue::Null => return None,
        YamlValue::String(text) => text.clone(),
        YamlValue::Number(x) => number_to_string(*x),
        YamlValue::Bool(b) => b.to_string(),
        YamlValue::Date(ms) => spelled_date(*ms),
        other => js_stringify(&json_of(other, seen)?),
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
/// `Buffer`'s JSON, a number that is not finite as `null`. `None` for a collection in `seen`,
/// which holds every collection turned into JSON so far.
fn json_of(value: &YamlValue, seen: &mut HashSet<usize>) -> Option<Value> {
    VISITS.with(|visits| visits.set(visits.get() + 1));
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
        YamlValue::Seq(items) => {
            if !seen.insert(Arc::as_ptr(items) as usize) {
                return None;
            }
            Value::Array(
                items
                    .iter()
                    .map(|item| json_of(item, seen))
                    .collect::<Option<_>>()?,
            )
        }
        YamlValue::Map(map) => {
            if !seen.insert(Arc::as_ptr(map) as usize) {
                return None;
            }
            Value::Object(
                map.iter()
                    .map(|(key, value)| Some((key.to_owned(), json_of(value, seen)?)))
                    .collect::<Option<_>>()?,
            )
        }
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
