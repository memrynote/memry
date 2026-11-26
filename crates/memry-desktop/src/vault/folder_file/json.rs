//! A `.folder.md`'s values as the renderer reads them, and back: a date is its ISO string, as
//! Electron hands a `Date` on, and comes back as the date it was.

use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, iso_string, json_to_yaml, yaml_to_json,
};
use serde_json::{Map, Value};

/// `value` as JSON, a date as its ISO string (`JSON.stringify` of a `Date`); `None` when it holds
/// what JSON cannot (bytes, a NaN, an infinity).
pub(super) fn to_json(value: &YamlValue) -> Option<Value> {
    match value {
        YamlValue::Date(ms) => Some(Value::String(iso_string(*ms))),
        YamlValue::Seq(items) => items
            .iter()
            .map(to_json)
            .collect::<Option<_>>()
            .map(Value::Array),
        YamlValue::Map(map) => map
            .iter()
            .map(|(key, value)| Some((key.to_owned(), to_json(value)?)))
            .collect::<Option<Map<_, _>>>()
            .map(Value::Object),
        scalar => yaml_to_json(scalar),
    }
}

/// `value` as YAML, a string that is the ISO form of the date `stored` holds at the same place
/// written as that date: Electron hands the renderer a `Date` and writes it back as one. A list
/// whose length changed is written as sent: its places no longer line up with the stored ones.
pub(super) fn revive(value: &Value, stored: Option<&YamlValue>) -> YamlValue {
    match (value, stored) {
        (Value::String(text), Some(YamlValue::Date(ms))) if *text == iso_string(*ms) => {
            YamlValue::Date(*ms)
        }
        (Value::Array(items), Some(YamlValue::Seq(stored))) if items.len() == stored.len() => {
            YamlValue::seq(
                items
                    .iter()
                    .enumerate()
                    .map(|(at, item)| revive(item, stored.get(at)))
                    .collect(),
            )
        }
        (Value::Object(object), Some(YamlValue::Map(stored))) => {
            let mut map = YamlMap::new();
            for (key, value) in object {
                map.insert(key.clone(), revive(value, stored.get(key)));
            }
            YamlValue::map(map)
        }
        _ => json_to_yaml(value),
    }
}
