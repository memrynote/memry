//! The payload readers: a field table per type, applied to an **untyped** JSON
//! object (chapter 13 §13.2, §13.7).
//!
//! There is no `#[derive(Deserialize)]` struct anywhere in this module, and
//! that is the point. A derived struct is a storage shape: deserialising into
//! it and re-serialising drops every key the build does not know about, which
//! is desktop's #2183 bug reproduced exactly (§13.2.1). What lives here instead
//! is a *reader*: it copies the modelled keys out of a parsed copy and leaves
//! the parsed copy — and the stored string it came from — untouched.
//!
//! Three rules the table encodes, and each one is load bearing:
//!
//! - **Absent is not null** (§13.4). An absent key is skipped; an explicit
//!   `null` is copied through as `null`, because it is an explicit clear. A
//!   reader that collapsed the two would erase a field every time an older peer
//!   round-tripped a row it could not model.
//! - **Almost everything is optional** (§13.3). A field is marked required only
//!   where the chapter says the word, because a required field added to an
//!   existing type turns a newer peer's payload into a corrupt row.
//! - **A schema failure is corrupt, never skipped** (§13.2 rule 5). Every
//!   rejection here is a [`ProjectionError`], and the caller records it against
//!   the row rather than advancing past it.

use serde_json::{Map, Value};
use thiserror::Error;

use super::instants;

/// A parsed payload. Always a JSON object at the top level.
pub type Object = Map<String, Value>;

/// Why a payload could not be read.
///
/// The `Display` text is what lands in `sync_items.corrupt_reason`, so it names
/// the type and the field: a corrupt row that says only "parse failed" cannot be
/// triaged from a user's device.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProjectionError {
    /// The stored bytes are not JSON at all.
    #[error("payload is not JSON: {what}")]
    NotJson { what: String },

    /// JSON, but not an object. Every payload schema is an object.
    #[error("payload is not a JSON object")]
    NotAnObject,

    /// A field the chapter marks required is absent.
    #[error("{item_type}: required field `{field}` is absent")]
    MissingField {
        item_type: &'static str,
        field: &'static str,
    },

    /// A field is present with a shape the schema does not allow.
    #[error("{item_type}: field `{field}` is {found}, expected {expected}")]
    WrongType {
        item_type: &'static str,
        field: &'static str,
        expected: &'static str,
        found: String,
    },

    /// A type with no reader. Chapter 05 §5.3.1: record it corrupt, do not
    /// apply it. The record feed cannot produce one today, because the server
    /// filters on the declared set, so this is a defensive rule.
    #[error("no payload reader for item type `{item_type}`")]
    UnknownType { item_type: String },
}

/// What a field may hold, after `null` has been dealt with by [`Field`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Any string.
    Text,
    /// One of a fixed set of strings.
    Enum(&'static [&'static str]),
    /// Any JSON number.
    Number,
    /// A boolean.
    Bool,
    /// An array of strings.
    TextArray,
    /// An array of anything.
    Array,
    /// A JSON object, contents unconstrained.
    Object,
    /// `VectorClockSchema`: an object whose every value is a number.
    Clock,
    /// An object whose every value is a clock (`fieldClocks`).
    ClockMap,
    /// `SyncTimestampSchema` (§13.5): **string or number**, normalised to the
    /// string shape. The union is permanent — payloads written by the phone as
    /// `Date.now()` are already on the server — and the string is what a
    /// conforming client emits.
    SyncTimestamp,
    /// Deliberately opaque: `repeatConfig`, `oldValue`, `newValue`.
    Any,
}

impl Kind {
    fn describe(self) -> &'static str {
        match self {
            Self::Text => "a string",
            Self::Enum(_) => "one of the allowed strings",
            Self::Number => "a number",
            Self::Bool => "a boolean",
            Self::TextArray => "an array of strings",
            Self::Array => "an array",
            Self::Object => "an object",
            Self::Clock => "a vector clock",
            Self::ClockMap => "a map of vector clocks",
            Self::SyncTimestamp => "a string or a number",
            Self::Any => "anything",
        }
    }
}

/// One entry in a type's field table.
#[derive(Debug, Clone, Copy)]
pub struct Field {
    pub name: &'static str,
    pub kind: Kind,
    /// Whether an explicit `null` is allowed. `null` is an explicit clear
    /// (§13.4); a non-nullable field carrying `null` fails the schema.
    pub nullable: bool,
    /// Whether the key must be present. Marked only where the chapter says so.
    pub required: bool,
}

impl Field {
    /// Optional, and `null` is not one of its values.
    pub const fn opt(name: &'static str, kind: Kind) -> Self {
        Self {
            name,
            kind,
            nullable: false,
            required: false,
        }
    }

    /// Optional, and `null` clears it.
    pub const fn opt_null(name: &'static str, kind: Kind) -> Self {
        Self {
            name,
            kind,
            nullable: true,
            required: false,
        }
    }

    /// Required, and `null` is not one of its values.
    pub const fn req(name: &'static str, kind: Kind) -> Self {
        Self {
            name,
            kind,
            nullable: false,
            required: true,
        }
    }

    /// Required, and `null` is one of its values — `folder_config.icon`, the
    /// only non-optional field on any subscribed type (§13.7.10).
    pub const fn req_null(name: &'static str, kind: Kind) -> Self {
        Self {
            name,
            kind,
            nullable: true,
            required: true,
        }
    }
}

/// Applies a field table to a parsed payload copy.
///
/// Returns a **new** object holding only the modelled keys. Every key outside
/// the table is left where it was — in the payload string the caller stored
/// verbatim — and never appears here, which is what makes a projection column a
/// cache of a parse rather than the storage shape.
pub fn read_fields(
    item_type: &'static str,
    input: &Object,
    spec: &[Field],
) -> Result<Object, ProjectionError> {
    let mut out = Object::new();
    for field in spec {
        let Some(value) = input.get(field.name) else {
            if field.required {
                return Err(ProjectionError::MissingField {
                    item_type,
                    field: field.name,
                });
            }
            continue;
        };

        if value.is_null() {
            if !field.nullable {
                return Err(wrong_type(item_type, field, value));
            }
            out.insert(field.name.to_owned(), Value::Null);
            continue;
        }

        out.insert(field.name.to_owned(), check(item_type, field, value)?);
    }
    Ok(out)
}

fn check(item_type: &'static str, field: &Field, value: &Value) -> Result<Value, ProjectionError> {
    let ok = match field.kind {
        Kind::Text => value.is_string(),
        Kind::Enum(allowed) => value.as_str().is_some_and(|text| allowed.contains(&text)),
        Kind::Number => value.is_number(),
        Kind::Bool => value.is_boolean(),
        Kind::TextArray => value
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string)),
        Kind::Array => value.is_array(),
        Kind::Object => value.is_object(),
        Kind::Clock => is_clock(value),
        Kind::ClockMap => value
            .as_object()
            .is_some_and(|paths| paths.values().all(is_clock)),
        Kind::SyncTimestamp => value.is_string() || value.is_number(),
        Kind::Any => true,
    };

    if !ok {
        return Err(wrong_type(item_type, field, value));
    }

    if field.kind == Kind::SyncTimestamp
        && let Some(number) = value.as_f64()
    {
        // §13.5: `new Date(value).toISOString()`. `Date` truncates its argument
        // toward zero before treating it as epoch milliseconds.
        let millis = number.trunc();
        let text = instants::to_iso8601(millis as i64).ok_or_else(|| {
            wrong_type_named(
                item_type,
                field,
                "a timestamp inside the representable range",
                value,
            )
        })?;
        return Ok(Value::String(text));
    }

    Ok(value.clone())
}

fn is_clock(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|ticks| ticks.values().all(Value::is_number))
}

fn wrong_type(item_type: &'static str, field: &Field, found: &Value) -> ProjectionError {
    wrong_type_named(item_type, field, field.kind.describe(), found)
}

fn wrong_type_named(
    item_type: &'static str,
    field: &Field,
    expected: &'static str,
    found: &Value,
) -> ProjectionError {
    ProjectionError::WrongType {
        item_type,
        field: field.name,
        expected,
        found: describe(found),
    }
}

/// Names a value's JSON shape without quoting its contents: a corrupt reason is
/// written to disk and read from logs, and a note body does not belong in
/// either.
fn describe(value: &Value) -> String {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SPEC: &[Field] = &[
        Field::opt("title", Kind::Text),
        Field::opt_null("emoji", Kind::Text),
        Field::req("name", Kind::Text),
        Field::opt("clock", Kind::Clock),
        Field::opt("createdAt", Kind::SyncTimestamp),
    ];

    fn object(value: Value) -> Object {
        value.as_object().expect("an object").clone()
    }

    #[test]
    fn an_unknown_key_is_left_out_of_the_read_view() {
        let read = read_fields("probe", &object(json!({"name": "n", "future": 1})), SPEC).unwrap();
        assert_eq!(read, object(json!({"name": "n"})));
    }

    #[test]
    fn absent_and_null_stay_distinct() {
        let absent = read_fields("probe", &object(json!({"name": "n"})), SPEC).unwrap();
        assert!(!absent.contains_key("emoji"));

        let cleared =
            read_fields("probe", &object(json!({"name": "n", "emoji": null})), SPEC).unwrap();
        assert_eq!(cleared.get("emoji"), Some(&Value::Null));
    }

    #[test]
    fn a_null_in_a_field_that_does_not_take_one_fails_the_schema() {
        let error = read_fields("probe", &object(json!({"name": "n", "title": null})), SPEC)
            .expect_err("title is not nullable");
        assert!(matches!(
            error,
            ProjectionError::WrongType { field: "title", .. }
        ));
    }

    #[test]
    fn a_missing_required_field_is_corrupt_not_skipped() {
        let error = read_fields("probe", &object(json!({"title": "t"})), SPEC)
            .expect_err("name is required");
        assert_eq!(
            error,
            ProjectionError::MissingField {
                item_type: "probe",
                field: "name"
            }
        );
    }

    #[test]
    fn a_numeric_sync_timestamp_normalises_to_the_string_shape() {
        let read = read_fields(
            "probe",
            &object(json!({"name": "n", "createdAt": 1_760_000_000_000_i64})),
            SPEC,
        )
        .unwrap();
        assert_eq!(read["createdAt"], json!("2025-10-09T08:53:20.000Z"));
    }

    #[test]
    fn a_clock_whose_ticks_are_not_numbers_fails() {
        let error = read_fields(
            "probe",
            &object(json!({"name": "n", "clock": {"device-a": "1"}})),
            SPEC,
        )
        .expect_err("a tick is a number");
        assert!(matches!(
            error,
            ProjectionError::WrongType { field: "clock", .. }
        ));
    }
}
