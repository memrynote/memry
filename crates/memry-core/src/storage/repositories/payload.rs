//! The stored payload: the bytes, and the only two operations allowed on them
//! (chapter 13 §13.2, FR-033, data-model §A.1).
//!
//! [`StoredPayload`] holds the decrypted payload **string** and a parsed copy
//! of it, and it is deliberately impossible to get the string back out of the
//! copy. [`StoredPayload::raw`] returns the bytes that were received;
//! [`StoredPayload::object`] returns the throwaway copy a projector reads. The
//! copy is never serialised on the unedited path, so a key this build does not
//! model cannot be lost by a round trip that did not change anything.
//!
//! The one path that does serialise is [`StoredPayload::merge`], which is
//! §13.2 rule 3: parse a copy, merge the changed keys into it, serialise **that
//! merged object**, with the unknown keys still in it. A projection row is
//! never the input to this, which is §13.2 rule 4.
//!
//! ## Key order
//!
//! `serde_json`'s object is a `BTreeMap`, so a merged payload comes out with
//! its keys sorted by code point. That is exactly the canonical form chapter 06
//! §6.4.2 mandates for value comparison (decision #2185), so a reordering is
//! not a difference to any conforming peer — and no key is added, dropped or
//! rewritten by it. The unedited path returns the received bytes untouched, so
//! the byte-for-byte round trip the vectors pin does not go anywhere near this.

use serde_json::{Map, Value};

use super::schema::{Object, ProjectionError};

/// A payload as stored: the verbatim string, plus a parsed copy to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPayload {
    raw: String,
    object: Object,
}

impl StoredPayload {
    /// Parses the decrypted payload. The string is kept as given.
    pub fn parse(raw: &str) -> Result<Self, ProjectionError> {
        let value: Value = serde_json::from_str(raw).map_err(|error| ProjectionError::NotJson {
            what: error.to_string(),
        })?;
        let Value::Object(object) = value else {
            return Err(ProjectionError::NotAnObject);
        };
        Ok(Self {
            raw: raw.to_owned(),
            object,
        })
    }

    /// The bytes as received. This is what a push sends and what
    /// `sync_items.payload` holds.
    pub fn raw(&self) -> &str {
        &self.raw
    }

    /// The throwaway copy a projector reads (§13.2 rule 2).
    pub fn object(&self) -> &Object {
        &self.object
    }

    /// §13.2 rule 3: the payload a local edit pushes.
    ///
    /// Merges `changes` into the parsed copy and serialises **that**. A key in
    /// `changes` whose value is `null` is written as `null`, because `null` is
    /// an explicit clear and absence is not (§13.4); [`Change::Remove`] is the
    /// separate, rarer operation of dropping the key entirely.
    ///
    /// No change at all returns the received bytes, unmodified.
    pub fn merge(&self, changes: &[(&str, Change)]) -> String {
        if changes.is_empty() {
            return self.raw.clone();
        }
        let mut merged = self.object.clone();
        for (key, change) in changes {
            match change {
                Change::Set(value) => {
                    merged.insert((*key).to_owned(), value.clone());
                }
                Change::Remove => {
                    merged.remove(*key);
                }
            }
        }
        serde_json::to_string(&Value::Object(merged))
            .expect("a Map<String, Value> parsed from JSON always re-serialises")
    }
}

/// What a local edit does to one key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// Write the value. `Set(Value::Null)` is the explicit clear of §13.4.
    Set(Value),
    /// Drop the key, so the receiver keeps its own value (§13.4's "absent").
    Remove,
}

impl Change {
    /// `Set`, for the common case of a value that is already a `Value`.
    pub fn set(value: impl Into<Value>) -> Self {
        Self::Set(value.into())
    }
}

/// Serialises a modelled sub-object back to JSON text for a projection column.
///
/// Used only for columns §A.4 declares as JSON text — `notes.properties`,
/// `tasks.tags`, `property_definitions.options` — never for a payload.
pub fn json_text(value: &Value) -> String {
    serde_json::to_string(value).expect("a Value parsed from JSON always re-serialises")
}

/// An empty parsed object, for the metadata-only rows that have no payload yet.
pub fn empty_object() -> Object {
    Map::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NEWER: &str =
        r#"{"title":"A note","coverImage":{"url":"memry://cover/1","offsetY":0.25}}"#;

    #[test]
    fn the_received_bytes_come_back_out_unchanged() {
        let payload = StoredPayload::parse(NEWER).unwrap();
        assert_eq!(payload.raw(), NEWER);
        assert_eq!(payload.merge(&[]), NEWER);
    }

    #[test]
    fn a_local_edit_keeps_the_key_this_build_does_not_model() {
        let payload = StoredPayload::parse(NEWER).unwrap();
        let pushed = payload.merge(&[("title", Change::set("Renamed"))]);

        let reparsed: Value = serde_json::from_str(&pushed).unwrap();
        assert_eq!(reparsed["title"], json!("Renamed"));
        assert_eq!(
            reparsed["coverImage"],
            json!({"url": "memry://cover/1", "offsetY": 0.25})
        );
    }

    #[test]
    fn a_null_change_is_an_explicit_clear_and_a_removal_is_not() {
        let payload = StoredPayload::parse(r#"{"emoji":"📓","title":"t"}"#).unwrap();

        let cleared: Value =
            serde_json::from_str(&payload.merge(&[("emoji", Change::Set(Value::Null))])).unwrap();
        assert_eq!(cleared["emoji"], Value::Null);

        let dropped: Value =
            serde_json::from_str(&payload.merge(&[("emoji", Change::Remove)])).unwrap();
        assert!(dropped.get("emoji").is_none());
    }

    #[test]
    fn a_payload_that_is_not_an_object_is_rejected_rather_than_stored_as_one() {
        assert_eq!(
            StoredPayload::parse("[1,2,3]"),
            Err(ProjectionError::NotAnObject)
        );
        assert!(matches!(
            StoredPayload::parse("{"),
            Err(ProjectionError::NotJson { .. })
        ));
    }
}
