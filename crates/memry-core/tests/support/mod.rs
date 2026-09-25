// Each file under `tests/` is its own crate, so this module is compiled once per
// test binary and each one uses a different subset of it. Without this, adding a
// helper for one suite warns in every other.
#![allow(dead_code)]

//! Shared plumbing for the conformance vector harness.
//!
//! The three governing rules live in
//! `packages/contracts/test-vectors/README.md`. The one that shapes this file
//! is rule 2: **verification is a separate program from generation.** Nothing
//! here regenerates a vector, computes an expectation, or imports a builder.
//! The committed JSON is the input and the only input.
//!
//! `include_str!` reaches the contracts package directly so that there is
//! exactly one copy of each vector in the repository. Copying them under
//! `crates/` would create a second artefact that can drift from the first, and a
//! drift that no gate can see is the failure mode the whole vector scheme exists
//! to prevent.

use ciborium::value::Value;
use serde_json::Value as Json;

/// Loads a committed vector file by its name under
/// `packages/contracts/test-vectors/`.
///
/// A `match` rather than a path built at runtime, because `include_str!` needs a
/// literal: the bytes are compiled in, so a test binary cannot pass against a
/// file that was deleted or moved.
pub fn vector_file(name: &str) -> Json {
    let raw = match name {
        "crypto-vectors" => {
            include_str!("../../../../packages/contracts/test-vectors/crypto-vectors.json")
        }
        "bip39-unlock" => {
            include_str!("../../../../packages/contracts/test-vectors/bip39-unlock.json")
        }
        "cbor-canonical" => {
            include_str!("../../../../packages/contracts/test-vectors/cbor-canonical.json")
        }
        "compression" => {
            include_str!("../../../../packages/contracts/test-vectors/compression.json")
        }
        "record-envelope" => {
            include_str!("../../../../packages/contracts/test-vectors/record-envelope.json")
        }
        "crdt-update" => {
            include_str!("../../../../packages/contracts/test-vectors/crdt-update.json")
        }
        "field-merge" => {
            include_str!("../../../../packages/contracts/test-vectors/field-merge.json")
        }
        "pack-container" => {
            include_str!("../../../../packages/contracts/test-vectors/pack-container.json")
        }
        "payload-schemas" => {
            include_str!("../../../../packages/contracts/test-vectors/payload-schemas.json")
        }
        "device-linking" => {
            include_str!("../../../../packages/contracts/test-vectors/device-linking.json")
        }
        "text-extract" => {
            include_str!("../../../../packages/contracts/test-vectors/text-extract.json")
        }
        "note-blocks" => {
            include_str!("../../../../packages/contracts/test-vectors/note-blocks.json")
        }
        "block-edit" => {
            include_str!("../../../../packages/contracts/test-vectors/block-edit.json")
        }
        "attachment-manifest" => {
            include_str!("../../../../packages/contracts/test-vectors/attachment-manifest.json")
        }
        "task-parsing" => {
            include_str!("../../../../packages/contracts/test-vectors/task-parsing.json")
        }
        "task-filtering" => {
            include_str!("../../../../packages/contracts/test-vectors/task-filtering.json")
        }
        "journal" => include_str!("../../../../packages/contracts/test-vectors/journal.json"),
        other => panic!("no committed vector file named {other}"),
    };
    serde_json::from_str(raw)
        .unwrap_or_else(|error| panic!("{name}.json is not valid JSON: {error}"))
}

/// Reads a hex field, or panics naming the field.
pub fn hex_field(case: &Json, field: &str) -> Vec<u8> {
    let text = case[field]
        .as_str()
        .unwrap_or_else(|| panic!("case is missing hex field `{field}`: {case}"));
    hex::decode(text).unwrap_or_else(|error| panic!("`{field}` is not hex: {error}"))
}

/// Reads a hex field that the vector may legitimately omit or set to `null`.
pub fn optional_hex_field(case: &Json, field: &str) -> Option<Vec<u8>> {
    match case.get(field) {
        None | Some(Json::Null) => None,
        Some(Json::String(text)) => {
            Some(hex::decode(text).unwrap_or_else(|error| panic!("`{field}` is not hex: {error}")))
        }
        Some(other) => panic!("`{field}` is neither absent nor hex: {other}"),
    }
}

/// Reads a string field, or panics naming the field.
pub fn str_field<'a>(case: &'a Json, field: &str) -> &'a str {
    case[field]
        .as_str()
        .unwrap_or_else(|| panic!("case is missing string field `{field}`: {case}"))
}

/// The plaintext of a vector case, which may be spelled as UTF-8 or as hex.
pub fn plaintext(case: &Json) -> Vec<u8> {
    if let Some(text) = case.get("plaintextUtf8").and_then(Json::as_str) {
        return text.as_bytes().to_vec();
    }
    hex_field(case, "plaintextHex")
}

/// Converts a vector's JSON input into the CBOR value model.
///
/// Two markers exist because JSON cannot spell what CBOR needs, and both are
/// part of the vector format rather than of the protocol:
///
/// - `{"$bytesHex": "010203"}` is a **byte string**, CBOR major type 2, not an
///   array of integers;
/// - `{"$undefined": true}` is JavaScript `undefined`, which omits its key
///   entirely. `null` is a *value* and encodes as `f6`, so the two are not
///   interchangeable.
///
/// Returns `None` for `$undefined`, which the caller drops.
pub fn json_to_cbor(value: &Json) -> Option<Value> {
    Some(match value {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::String(s) => Value::Text(s.clone()),
        Json::Number(n) => {
            if let Some(u) = n.as_u64() {
                Value::Integer(u.into())
            } else if let Some(i) = n.as_i64() {
                Value::Integer(i.into())
            } else {
                Value::Float(n.as_f64().expect("a JSON number is one of these three"))
            }
        }
        Json::Array(items) => Value::Array(items.iter().filter_map(json_to_cbor).collect()),
        Json::Object(fields) => {
            if let Some(Json::String(hex_text)) = fields.get("$bytesHex") {
                return Some(Value::Bytes(
                    hex::decode(hex_text).expect("$bytesHex is not hex"),
                ));
            }
            if fields.get("$undefined").and_then(Json::as_bool) == Some(true) {
                return None;
            }
            Value::Map(
                fields
                    .iter()
                    .filter_map(|(key, value)| {
                        json_to_cbor(value).map(|v| (Value::Text(key.clone()), v))
                    })
                    .collect(),
            )
        }
    })
}
