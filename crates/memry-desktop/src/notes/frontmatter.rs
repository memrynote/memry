//! What a note file's frontmatter means to the app (`vault/frontmatter.ts`, protocol 12.4):
//! `tags` and `aliases` are the only keys Memry manages; every other key is a user property,
//! except the legacy nested `properties` envelope and the cover and writing keys while their
//! values are theirs (`isReservedFrontmatterKey`).

use memry_core::domain::note_stats::header_tags;
use memry_core::markdown::frontmatter::YamlValue;
use memry_core::markdown::shared::cover_image::is_cover_key_value;
use memry_core::markdown::shared::writing_tools::{
    WRITING_FRONTMATTER_KEY, is_writing_frontmatter_value,
};
use memry_core::storage::repositories::instants::to_iso8601;
use serde_json::{Map, Value};

/// `isReservedFrontmatterKey`.
pub fn is_reserved_key(name: &str, value: &Value) -> bool {
    match name {
        "tags" | "aliases" | "properties" => true,
        WRITING_FRONTMATTER_KEY => is_writing_frontmatter_value(value),
        _ => is_cover_key_value(name, value),
    }
}

/// What `parseNote` and the index read off a note file's frontmatter.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileFields {
    /// The frontmatter `tags` list alone (`extractTags`).
    pub header_tags: Vec<String>,
    /// `frontmatter.aliases`, a lone value as a one-item list.
    pub aliases: Vec<String>,
    /// The user properties (`extractProperties`).
    pub properties: Map<String, Value>,
    /// The whole frontmatter.
    pub frontmatter: Map<String, Value>,
}

/// The fields of a parsed frontmatter; a top level that is not a map has none. A lone `tags`
/// or `aliases` value reads as a one-item list, in the frontmatter too (`parseNote`).
pub fn file_fields(yaml: &YamlValue) -> FileFields {
    let (YamlValue::Map(map), Value::Object(mut frontmatter)) = (yaml, to_json(yaml)) else {
        return FileFields::default();
    };
    for key in ["tags", "aliases"] {
        if let Some(value) = frontmatter.get_mut(key)
            && !value.is_array()
            && truthy(value)
        {
            *value = Value::Array(vec![Value::String(scalar_text(value))]);
        }
    }
    FileFields {
        // The index's reader, so a note's header tags read the same wherever they are read.
        header_tags: header_tags(map),
        aliases: match frontmatter.get("aliases") {
            Some(Value::Array(items)) => items.iter().map(scalar_text).collect(),
            _ => Vec::new(),
        },
        properties: properties(&frontmatter),
        frontmatter,
    }
}

/// `extractProperties`: the legacy nested envelope first, then the top level, which wins.
fn properties(frontmatter: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(Value::Object(nested)) = frontmatter.get("properties") {
        for (name, value) in nested {
            if !is_reserved_key(name, value) {
                out.insert(name.clone(), value.clone());
            }
        }
    }
    for (name, value) in frontmatter {
        if !is_reserved_key(name, value) {
            out.insert(name.clone(), value.clone());
        }
    }
    out
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `stringifyScalar`.
fn scalar_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// The value as the renderer reads it over IPC: a YAML date is its ISO text, bytes and a
/// number that is not finite are `null`.
fn to_json(value: &YamlValue) -> Value {
    match value {
        YamlValue::Null | YamlValue::Binary(_) => Value::Null,
        YamlValue::Bool(b) => Value::Bool(*b),
        YamlValue::Number(x) => number(*x),
        YamlValue::String(text) => Value::String(text.clone()),
        YamlValue::Date(ms) => to_iso8601(*ms).map_or(Value::Null, Value::String),
        YamlValue::Seq(items) => Value::Array(items.iter().map(to_json).collect()),
        YamlValue::Map(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.to_owned(), to_json(value)))
                .collect(),
        ),
    }
}

fn number(x: f64) -> Value {
    // 2^53: an integral value within it is a JSON integer, as JavaScript prints it.
    const SAFE: f64 = 9_007_199_254_740_992.0;
    if x.fract() == 0.0 && x.abs() <= SAFE {
        #[allow(clippy::cast_possible_truncation, reason = "integral and within 2^53")]
        return Value::from(x as i64);
    }
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use memry_core::markdown::frontmatter::parse_markdown_note;
    use serde_json::json;

    fn fields(raw: &str) -> FileFields {
        file_fields(&parse_markdown_note(raw).unwrap().frontmatter)
    }

    #[test]
    fn a_cover_value_is_not_a_property_and_prose_under_its_key_is() {
        let f = fields("---\ncover: wash:sage\ncoverCredit: Ann\n---\n");
        assert!(f.properties.is_empty(), "{:?}", f.properties);
        let f = fields("---\ncover: Hardback\n---\n");
        assert_eq!(
            f.properties,
            *json!({ "cover": "Hardback" }).as_object().unwrap()
        );
    }

    #[test]
    fn tags_and_aliases_read_as_parse_note_reads_them() {
        let f = fields("---\ntags: [ ' A ', a, '', 3, B ]\naliases: Solo\n---\n");
        assert_eq!(f.header_tags, ["A", "B"]);
        assert_eq!(f.aliases, ["Solo"]);
        let f = fields("---\ntags: one\n---\n");
        assert_eq!(f.header_tags, ["one"]);
        assert_eq!(f.frontmatter["tags"], json!(["one"]));
        let f = fields("---\ntags: 0\naliases: false\n---\n");
        assert!(f.header_tags.is_empty() && f.aliases.is_empty());
    }

    #[test]
    fn the_top_level_wins_over_the_nested_envelope_and_dates_read_as_iso_text() {
        let f = fields("---\nproperties:\n  a: 1\n  b: 2\nb: 3\ndue: 2026-10-07\n---\n");
        assert_eq!(
            f.properties,
            *json!({ "a": 1, "b": 3, "due": "2026-10-07T00:00:00.000Z" })
                .as_object()
                .unwrap()
        );
    }

    #[test]
    fn a_frontmatter_that_is_not_a_map_has_no_fields() {
        assert_eq!(fields("---\n- a\n---\nBody"), FileFields::default());
    }
}
