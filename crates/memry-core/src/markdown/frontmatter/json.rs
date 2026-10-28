//! Frontmatter values as plain JSON, for rules ported from TypeScript that read gray-matter's
//! `data` as objects (the `writing` key of `writing_tools`).
//!
//! JavaScript has one number type, so an integral number is one JSON integer whatever its
//! YAML spelling (`1` and `1.0` compare equal, as they do under `isDeepStrictEqual`).

use serde_json::{Map, Number, Value};

use super::value::{YamlMap, YamlValue};

/// The value as JSON, or `None` when it holds what no JSON value is: a `Date` or a `Buffer`
/// (objects in JavaScript), or a number that is not finite.
pub fn yaml_to_json(value: &YamlValue) -> Option<Value> {
    Some(match value {
        YamlValue::Null => Value::Null,
        YamlValue::Bool(b) => Value::Bool(*b),
        YamlValue::Number(x) => Value::Number(number(*x)?),
        YamlValue::String(text) => Value::String(text.clone()),
        YamlValue::Date(_) | YamlValue::Binary(_) => return None,
        YamlValue::Seq(items) => {
            Value::Array(items.iter().map(yaml_to_json).collect::<Option<_>>()?)
        }
        YamlValue::Map(map) => Value::Object(
            map.iter()
                .map(|(key, value)| Some((key.to_owned(), yaml_to_json(value)?)))
                .collect::<Option<Map<_, _>>>()?,
        ),
    })
}

/// The YAML value of a JSON one, keys in their order.
pub fn json_to_yaml(value: &Value) -> YamlValue {
    match value {
        Value::Null => YamlValue::Null,
        Value::Bool(b) => YamlValue::Bool(*b),
        Value::Number(n) => YamlValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => YamlValue::String(text.clone()),
        Value::Array(items) => YamlValue::seq(items.iter().map(json_to_yaml).collect()),
        Value::Object(object) => {
            let mut map = YamlMap::new();
            for (key, value) in object {
                map.insert(key.clone(), json_to_yaml(value));
            }
            YamlValue::map(map)
        }
    }
}

fn number(x: f64) -> Option<Number> {
    // 2^53: past it an f64 no longer holds every integer, and JavaScript prints it as a float.
    const SAFE: f64 = 9_007_199_254_740_992.0;
    if x.fract() == 0.0 && x.abs() <= SAFE {
        // Exact: integral and within the safe range.
        #[allow(clippy::cast_possible_truncation)]
        return Some(Number::from(x as i64));
    }
    Number::from_f64(x)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::frontmatter::safe_load;

    fn load(yaml: &str) -> YamlValue {
        safe_load(yaml).unwrap().unwrap()
    }

    #[test]
    fn a_whole_number_is_one_integer_whatever_its_spelling() {
        assert_eq!(yaml_to_json(&load("a: 1.0")), yaml_to_json(&load("a: 1")));
        assert_eq!(
            yaml_to_json(&load("a: 1.5")).unwrap()["a"],
            serde_json::json!(1.5)
        );
    }

    #[test]
    fn a_date_or_a_buffer_is_no_json_value() {
        assert_eq!(yaml_to_json(&load("a: 2026-01-02")), None);
        assert_eq!(yaml_to_json(&load("a: !!binary aGk=")), None);
        assert_eq!(yaml_to_json(&load("a: .nan")), None);
    }

    #[test]
    fn json_round_trips_through_yaml_in_key_order() {
        let json = serde_json::json!({"z": [1, "two", {"b": true, "a": null}], "a": 2.5});
        assert_eq!(yaml_to_json(&json_to_yaml(&json)), Some(json));
    }
}
