//! Canonical CBOR, chapter 04 §4.7.
//!
//! Two facts carry this whole module, and both are the opposite of the
//! reasonable guess:
//!
//! 1. **The field-order list is an allowlist, not the byte order.** It decides
//!    which top-level keys are encoded and rejects any defined key outside it.
//!    It does not decide what order they come out in.
//! 2. **The byte order is RFC 8949 §4.2.3, "Length-First Map Key Ordering",**
//!    applied recursively. It is **not** §4.2.1, the plain-bytewise core
//!    deterministic encoding that a Rust crate advertising "canonical" usually
//!    means. The two disagree whenever two keys differ in length, which is most
//!    real payloads.
//!
//! `ciborium::value::Value` supplies the value model and the decoder; the
//! canonical byte emitter is written out here because it is the part the
//! protocol pins, and no general-purpose encoder reproduces it by accident.

use ciborium::value::{Integer, Value};

use crate::api::errors::CborError;

/// A top-level payload: keys in whatever order the caller built them in.
///
/// Insertion order has no effect on the output bytes. A key that is absent must
/// be **absent**, not present-with-null: `null` encodes as `f6` and an empty map
/// is a different byte string from no key at all, so the distinction changes the
/// signature.
pub type CanonicalMap = Vec<(String, Value)>;

/// The `CBOR_FIELD_ORDER` allowlists, chapter 04 §4.7.3, verbatim.
///
/// `TOMBSTONE` is reserved and has no producer (§4.8.3): tombstones travel as
/// ordinary signed records with `deletedAt` set. It is listed because a client
/// must never encode under it, which is only checkable if it is named.
pub mod field_order {
    pub const SYNC_ITEM: &[&str] = &[
        "id",
        "type",
        "operation",
        "cryptoVersion",
        "encryptedKey",
        "keyNonce",
        "encryptedData",
        "dataNonce",
        "deletedAt",
        "metadata",
    ];
    pub const TOMBSTONE: &[&str] = &["id", "type", "deletedAt", "deviceId"];
    pub const LINKING_PROOF: &[&str] = &["sessionId", "devicePublicKey"];
    pub const SCAN_CONFIRM: &[&str] = &["sessionId", "initiatorPublicKey", "devicePublicKey"];
    pub const KEY_CONFIRM: &[&str] = &["sessionId", "encryptedMasterKey"];
    pub const PROVIDER_AUTH_CONFIRM: &[&str] = &["sessionId", "encryptedProviderAuth"];
    pub const VAULT_TRANSFER_CONFIRM: &[&str] = &["sessionId", "encryptedVaultTransfer"];
    pub const ATTACHMENT_MANIFEST: &[&str] = &[
        "encryptedManifest",
        "manifestNonce",
        "encryptedFileKey",
        "keyNonce",
    ];

    /// Looks an allowlist up by the name chapter 04 §4.7.3 gives it.
    pub fn by_name(name: &str) -> Option<&'static [&'static str]> {
        Some(match name {
            "SYNC_ITEM" => SYNC_ITEM,
            "TOMBSTONE" => TOMBSTONE,
            "LINKING_PROOF" => LINKING_PROOF,
            "SCAN_CONFIRM" => SCAN_CONFIRM,
            "KEY_CONFIRM" => KEY_CONFIRM,
            "PROVIDER_AUTH_CONFIRM" => PROVIDER_AUTH_CONFIRM,
            "VAULT_TRANSFER_CONFIRM" => VAULT_TRANSFER_CONFIRM,
            "ATTACHMENT_MANIFEST" => ATTACHMENT_MANIFEST,
            _ => return None,
        })
    }
}

/// Encodes a payload as canonical CBOR under its allowlist.
///
/// A key present in `input` but absent from `field_order` is a **hard error**,
/// never a silent exclusion: dropping it quietly would produce a signature over
/// a different field set than the caller believes it signed, and the server,
/// reconstructing from the fields it knows, would answer `403`.
///
/// The allowlist applies **only at the top level**. Nested keys are sorted by
/// the encoder and are neither included by nor rejected against the list.
pub fn encode(field_order: &[&str], input: &CanonicalMap) -> Result<Vec<u8>, CborError> {
    let unknown: Vec<&str> = input
        .iter()
        .map(|(key, _)| key.as_str())
        .filter(|key| !field_order.contains(key))
        .collect();
    if !unknown.is_empty() {
        return Err(CborError::FieldNotInOrdering {
            fields: unknown.join(", "),
        });
    }

    let entries: Vec<(Value, Value)> = field_order
        .iter()
        .filter_map(|name| {
            input
                .iter()
                .find(|(key, _)| key == name)
                .map(|(key, value)| (Value::Text(key.clone()), value.clone()))
        })
        .collect();

    let mut out = Vec::new();
    write_map(&mut out, entries)?;
    Ok(out)
}

/// Encodes an arbitrary value canonically, with no allowlist.
///
/// Used for nested structures and by callers that are not encoding one of the
/// named payloads.
pub fn encode_value(value: &Value) -> Result<Vec<u8>, CborError> {
    let mut out = Vec::new();
    write_value(&mut out, value)?;
    Ok(out)
}

fn write_value(out: &mut Vec<u8>, value: &Value) -> Result<(), CborError> {
    match value {
        Value::Null => out.push(0xf6),
        Value::Bool(false) => out.push(0xf4),
        Value::Bool(true) => out.push(0xf5),
        Value::Integer(integer) => write_integer(out, *integer),
        Value::Float(float) => write_float(out, *float),
        Value::Bytes(bytes) => {
            write_head(out, 2, bytes.len() as u64);
            out.extend_from_slice(bytes);
        }
        Value::Text(text) => {
            write_head(out, 3, text.len() as u64);
            out.extend_from_slice(text.as_bytes());
        }
        Value::Array(items) => {
            write_head(out, 4, items.len() as u64);
            for item in items {
                write_value(out, item)?;
            }
        }
        Value::Map(entries) => write_map(out, entries.clone())?,
        other => {
            return Err(CborError::Unencodable {
                what: format!("{other:?}"),
            });
        }
    }
    Ok(())
}

/// Writes a map with its keys in RFC 8949 §4.2.3 order.
///
/// The sort is over each key's **encoded bytes**, shorter first, ties broken
/// bytewise — which is why `z` (2 encoded bytes) precedes `aa` (3), and why a
/// plain-lexicographic encoder produces the right answer for every case except
/// that one and fails the moment two keys differ in length.
fn write_map(out: &mut Vec<u8>, entries: Vec<(Value, Value)>) -> Result<(), CborError> {
    let mut encoded: Vec<(Vec<u8>, Vec<u8>)> = Vec::with_capacity(entries.len());
    for (key, value) in entries {
        let mut key_bytes = Vec::new();
        write_value(&mut key_bytes, &key)?;
        let mut value_bytes = Vec::new();
        write_value(&mut value_bytes, &value)?;
        encoded.push((key_bytes, value_bytes));
    }
    encoded.sort_by(|a, b| a.0.len().cmp(&b.0.len()).then_with(|| a.0.cmp(&b.0)));

    write_head(out, 5, encoded.len() as u64);
    for (key_bytes, value_bytes) in encoded {
        out.extend_from_slice(&key_bytes);
        out.extend_from_slice(&value_bytes);
    }
    Ok(())
}

fn write_integer(out: &mut Vec<u8>, integer: Integer) {
    let value: i128 = integer.into();
    if value >= 0 {
        write_head(out, 0, value as u64);
    } else {
        // Major type 1 encodes -1 - n, so -1 is argument 0 and emits `20`.
        write_head(out, 1, (-1 - value) as u64);
    }
}

/// Writes a float under the §4.7.2 narrowing rule.
///
/// float16 when the value is exactly representable in it, float64 otherwise. An
/// encoder that always emits float64 signs different bytes for the same input,
/// which is the whole reason this rule is pinned by a vector.
fn write_float(out: &mut Vec<u8>, value: f64) {
    match f64_to_f16_exact(value) {
        Some(half) => {
            out.push(0xf9);
            out.extend_from_slice(&half.to_be_bytes());
        }
        None => {
            out.push(0xfb);
            out.extend_from_slice(&value.to_be_bytes());
        }
    }
}

/// A major type and its argument in shortest form.
fn write_head(out: &mut Vec<u8>, major: u8, argument: u64) {
    let major = major << 5;
    match argument {
        0..=23 => out.push(major | argument as u8),
        24..=0xff => {
            out.push(major | 24);
            out.push(argument as u8);
        }
        0x100..=0xffff => {
            out.push(major | 25);
            out.extend_from_slice(&(argument as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(major | 26);
            out.extend_from_slice(&(argument as u32).to_be_bytes());
        }
        _ => {
            out.push(major | 27);
            out.extend_from_slice(&argument.to_be_bytes());
        }
    }
}

/// Returns the float16 bit pattern when `value` is exactly representable in it.
///
/// Exactness is checked in two stages, because a value that is not exact in
/// float32 cannot be exact in float16: round-trip through `f32` first, then
/// confirm the exponent is in range and the low 13 mantissa bits are zero.
fn f64_to_f16_exact(value: f64) -> Option<u16> {
    let narrowed = value as f32;
    if f64::from(narrowed) != value && !value.is_nan() {
        return None;
    }

    let bits = narrowed.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32;
    let mantissa = bits & 0x007f_ffff;

    if exponent == 0xff {
        // Infinity and NaN both have an exact float16 spelling.
        return Some(sign | if mantissa == 0 { 0x7c00 } else { 0x7e00 });
    }
    if exponent == 0 && mantissa == 0 {
        return Some(sign);
    }

    let unbiased = exponent - 127;
    if !(-14..=15).contains(&unbiased) || mantissa & 0x1fff != 0 {
        return None;
    }
    Some(sign | (((unbiased + 15) as u16) << 10) | ((mantissa >> 13) as u16))
}
