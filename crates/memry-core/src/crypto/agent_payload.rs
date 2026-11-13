//! Which keys of an agent record's payload are sealed at rest, and how a
//! payload object is sealed and opened (chapter 13 §13.2.3's named exception,
//! §13.7.26-27).
//!
//! On the wire an `agent_conversation`'s `title` and an `agent_message`'s
//! `content` and `attachments` are plain JSON
//! (`AgentConversationSyncPayloadSchema`, `AgentMessageSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts:699-724`). In `sync_items.payload`
//! and the projection columns they hold the chapter 04 §4.17 envelope text of
//! the value: the title's text, or the JSON text of the content or attachment
//! list, as Electron stores them (`conversation-store.ts:53-55`,
//! `message-store.ts:51-65`). Every other key, unknown ones included, stays
//! as sent. Apply seals ([`seal_object`]), push opens ([`open_object`]), and
//! the opened value equals the wire value.
//!
//! A record pulled before the vault key was installed keeps its plain values
//! and is "pending" ([`is_pending`]) until [`seal_object`] runs over it.

use serde_json::Value;

use super::agent_envelope::{AtRestKey, Purpose, SealError};
use crate::storage::repositories::schema::Object;

/// The sealed keys of `item_type`'s payload and the purpose each seals under.
/// Empty for every other type.
pub fn sealed_keys(item_type: &str) -> &'static [(&'static str, Purpose)] {
    match item_type {
        "agent_conversation" => &[("title", Purpose::ConversationTitle)],
        "agent_message" => &[
            ("content", Purpose::MessageContent),
            ("attachments", Purpose::Attachments),
        ],
        _ => &[],
    }
}

/// Whether `value` has the shape of an envelope column: text holding exactly
/// the three keys `version` (a number), `nonce` and `ciphertext` (strings),
/// which is all a seal writes. Shape alone does not make a value sealed: a
/// plain title can be such text, so writes seal whatever they are given and
/// a reader treats a shaped value that does not open under the installed key
/// as plain ([`open_object`], [`seal_unsealed`]).
pub fn is_envelope(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    object.len() == 3
        && object.get("version").is_some_and(Value::is_number)
        && object.get("nonce").is_some_and(Value::is_string)
        && object.get("ciphertext").is_some_and(Value::is_string)
}

/// Whether a sealed key of `payload` still holds a plain value.
pub fn is_pending(item_type: &str, payload: &Object) -> bool {
    sealed_keys(item_type).iter().any(|(key, purpose)| {
        payload
            .get(*key)
            .is_some_and(|value| sealable(*purpose, value) && !is_envelope(value))
    })
}

/// Seals every sealed key of `payload` under `key`, for a write whose values
/// are all plain: a local write, an inbound wire payload, or merge winners
/// over an opened local record. A value shaped like an envelope is sealed
/// too, since a plain value can have that shape. An absent or `null` value
/// has nothing to seal, and a title that is not text is left for the reader
/// to refuse.
pub fn seal_object(
    item_type: &str,
    payload: &mut Object,
    key: &AtRestKey,
) -> Result<(), SealError> {
    for (name, purpose) in sealed_keys(item_type) {
        if let Some(value) = payload.get_mut(*name)
            && sealable(*purpose, value)
        {
            seal_value(*purpose, value, key)?;
        }
    }
    Ok(())
}

/// Seals the sealed keys of a stored `payload` that do not already open under
/// `key`, and says whether it sealed any. What [`seal_object`] is for a
/// stored record that may be pending: a value that opens is sealed already,
/// and anything else, a shaped value that does not open included, is plain.
pub fn seal_unsealed(
    item_type: &str,
    payload: &mut Object,
    key: &AtRestKey,
) -> Result<bool, SealError> {
    let mut sealed = false;
    for (name, purpose) in sealed_keys(item_type) {
        let Some(value) = payload.get_mut(*name) else {
            continue;
        };
        if !sealable(*purpose, value) || opens(*purpose, value, key)? {
            continue;
        }
        seal_value(*purpose, value, key)?;
        sealed = true;
    }
    Ok(sealed)
}

fn seal_value(purpose: Purpose, value: &mut Value, key: &AtRestKey) -> Result<(), SealError> {
    let plaintext = match &*value {
        Value::String(text) if purpose == Purpose::ConversationTitle => text.clone(),
        other => other.to_string(),
    };
    *value = Value::String(key.seal(purpose, &plaintext)?);
    Ok(())
}

/// Whether `value` is an envelope that opens under `key`. Only a missing key
/// is an error: without one nothing can be told apart.
fn opens(purpose: Purpose, value: &Value, key: &AtRestKey) -> Result<bool, SealError> {
    let Some(column) = value.as_str().filter(|_| is_envelope(value)) else {
        return Ok(false);
    };
    match key.open(purpose, column) {
        Ok(_) => Ok(true),
        Err(SealError::KeyUnavailable) => Err(SealError::KeyUnavailable),
        Err(_) => Ok(false),
    }
}

/// Opens every sealed key of `payload` back to its wire value. A plain value
/// (a pending record) is already the wire value and stays, and so does a
/// value shaped like an envelope that does not open under the installed key:
/// every write seals, so such a value was stored plain.
pub fn open_object(
    item_type: &str,
    payload: &mut Object,
    key: &AtRestKey,
) -> Result<(), SealError> {
    for (name, purpose) in sealed_keys(item_type) {
        let Some(value) = payload.get_mut(*name) else {
            continue;
        };
        let Some(column) = value.as_str().filter(|_| is_envelope(value)) else {
            continue;
        };
        let plaintext = match key.open(*purpose, column) {
            Ok(plaintext) => plaintext,
            Err(SealError::KeyUnavailable) => return Err(SealError::KeyUnavailable),
            Err(_) => continue,
        };
        *value = match purpose {
            Purpose::ConversationTitle => Value::String(plaintext),
            _ => serde_json::from_str(&plaintext).map_err(|_| SealError::Malformed)?,
        };
    }
    Ok(())
}

/// The `outbox.last_error` prefix of an agent row a push could not open, so
/// installing a key can release it from its backoff.
pub const HELD_REASON: &str = "held until it opens";

/// A stored payload's text with its sealed keys opened, the bytes a push
/// encrypts for the wire. `None` when there is nothing to open: another type,
/// or a payload that is not an object (the push decides what that means).
pub fn open_payload(
    item_type: &str,
    payload: &str,
    key: &AtRestKey,
) -> Result<Option<String>, SealError> {
    if sealed_keys(item_type).is_empty() {
        return Ok(None);
    }
    let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(payload) else {
        return Ok(None);
    };
    open_object(item_type, &mut object, key)?;
    Ok(Some(Value::Object(object).to_string()))
}

fn sealable(purpose: Purpose, value: &Value) -> bool {
    match purpose {
        Purpose::ConversationTitle => value.is_string(),
        _ => !value.is_null(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use zeroize::Zeroizing;

    use super::*;

    fn installed() -> AtRestKey {
        let key = AtRestKey::default();
        key.set(Some(Zeroizing::new([3; 32])));
        key
    }

    fn object(value: Value) -> Object {
        match value {
            Value::Object(object) => object,
            _ => unreachable!(),
        }
    }

    #[test]
    fn a_sealed_message_opens_to_the_wire_payload_and_unknown_keys_stay() {
        let key = installed();
        let wire = object(json!({
            "conversationId": "c1",
            "content": {"role": "user", "data": {"text": "secret plan"}},
            "attachments": [],
            "future": {"kept": true},
        }));
        let mut stored = wire.clone();
        assert!(is_pending("agent_message", &stored));
        seal_object("agent_message", &mut stored, &key).unwrap();
        assert!(!is_pending("agent_message", &stored));
        assert!(
            !Value::Object(stored.clone())
                .to_string()
                .contains("secret plan")
        );
        assert_eq!(stored["future"], wire["future"]);
        open_object("agent_message", &mut stored, &key).unwrap();
        assert_eq!(stored, wire);
    }

    #[test]
    fn sealing_a_stored_payload_twice_seals_once_and_absent_or_null_values_stay() {
        let key = installed();
        let mut stored = object(json!({"title": "Plan", "backendModel": null}));
        assert!(seal_unsealed("agent_conversation", &mut stored, &key).unwrap());
        let sealed = stored["title"].clone();
        assert!(!seal_unsealed("agent_conversation", &mut stored, &key).unwrap());
        assert_eq!(stored["title"], sealed);
        let mut message = object(json!({"content": null}));
        seal_object("agent_message", &mut message, &key).unwrap();
        assert_eq!(message, object(json!({"content": null})));
        assert!(!is_pending("agent_message", &message));
    }

    #[test]
    fn a_plain_title_shaped_like_an_envelope_is_sealed_and_opens_to_itself() {
        let key = installed();
        let shaped = r#"{"version":1,"nonce":"AAAA","ciphertext":"AAAA"}"#;
        assert!(is_envelope(&json!(shaped)));
        let mut written = object(json!({"title": shaped}));
        seal_object("agent_conversation", &mut written, &key).unwrap();
        assert_ne!(written["title"], json!(shaped), "a write seals it");
        let mut pending = object(json!({"title": shaped}));
        open_object("agent_conversation", &mut pending, &key).unwrap();
        assert_eq!(pending["title"], json!(shaped), "it reads as plain");
        assert!(seal_unsealed("agent_conversation", &mut pending, &key).unwrap());
        for mut sealed in [written, pending] {
            open_object("agent_conversation", &mut sealed, &key).unwrap();
            assert_eq!(sealed["title"], json!(shaped));
        }
    }

    #[test]
    fn without_a_key_a_seal_fails_and_a_plain_value_still_opens_as_itself() {
        let mut stored = object(json!({"title": "Plan"}));
        assert!(matches!(
            seal_object("agent_conversation", &mut stored, &AtRestKey::default()),
            Err(SealError::KeyUnavailable)
        ));
        open_object("agent_conversation", &mut stored, &AtRestKey::default()).unwrap();
        assert_eq!(stored["title"], "Plan");
    }
}
