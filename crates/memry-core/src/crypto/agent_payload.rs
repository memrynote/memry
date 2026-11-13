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
//! A record pulled while no vault key was installed keeps its plain values
//! and is sealed-pending
//! ([`crate::storage::repositories::projectors::agent::is_sealed_pending`]),
//! a fact recorded when the payload is written. Shape never decides it: a
//! plain title can look like an envelope, and an envelope that does not open
//! is an error, never a plain value.

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

/// Seals every sealed key of `payload` under `key`, for a write whose values
/// are all plain: a local write, an inbound wire payload, merge winners over
/// an opened local record, or a sealed-pending record. A value shaped like an
/// envelope is sealed too, since a plain value can have that shape. An absent
/// or `null` value has nothing to seal, and a title that is not text is left
/// for the reader to refuse.
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

fn seal_value(purpose: Purpose, value: &mut Value, key: &AtRestKey) -> Result<(), SealError> {
    let plaintext = match &*value {
        Value::String(text) if purpose == Purpose::ConversationTitle => text.clone(),
        other => other.to_string(),
    };
    *value = Value::String(key.seal(purpose, &plaintext)?);
    Ok(())
}

/// Opens every sealed key of a stored `payload` that is not sealed-pending
/// back to its wire value. Every such value was sealed when it was written,
/// so one that does not open is an error, whatever its shape: another key, a
/// version this build does not read (§0.2), altered bytes, or a plain value.
/// An absent or `null` value has nothing to open, and a title that is not
/// text is left for the reader to refuse.
pub fn open_object(
    item_type: &str,
    payload: &mut Object,
    key: &AtRestKey,
) -> Result<(), SealError> {
    for (name, purpose) in sealed_keys(item_type) {
        let Some(value) = payload
            .get_mut(*name)
            .filter(|value| sealable(*purpose, value))
        else {
            continue;
        };
        let column = value.as_str().ok_or(SealError::Malformed)?;
        let plaintext = key.open(*purpose, column)?;
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
/// a sealed-pending payload (already the wire value), or a payload that is
/// not an object (the push decides what that means).
pub fn open_payload(
    item_type: &str,
    payload: &str,
    pending: bool,
    key: &AtRestKey,
) -> Result<Option<String>, SealError> {
    if pending || sealed_keys(item_type).is_empty() {
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

    fn installed(byte: u8) -> AtRestKey {
        let key = AtRestKey::default();
        key.set(Some(Zeroizing::new([byte; 32])));
        key
    }

    fn object(value: Value) -> Object {
        match value {
            Value::Object(object) => object,
            _ => unreachable!(),
        }
    }

    fn sealed_title(key: &AtRestKey, title: &str) -> Object {
        let mut stored = object(json!({"title": title}));
        seal_object("agent_conversation", &mut stored, key).unwrap();
        stored
    }

    #[test]
    fn a_sealed_message_opens_to_the_wire_payload_and_unknown_keys_stay() {
        let key = installed(3);
        let wire = object(json!({
            "conversationId": "c1",
            "content": {"role": "user", "data": {"text": "secret plan"}},
            "attachments": [],
            "future": {"kept": true},
        }));
        let mut stored = wire.clone();
        seal_object("agent_message", &mut stored, &key).unwrap();
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
    fn absent_or_null_values_are_neither_sealed_nor_opened() {
        let key = installed(3);
        let mut message = object(json!({"content": null}));
        seal_object("agent_message", &mut message, &key).unwrap();
        assert_eq!(message, object(json!({"content": null})));
        open_object("agent_message", &mut message, &key).unwrap();
        assert_eq!(message, object(json!({"content": null})));
    }

    #[test]
    fn a_plain_title_shaped_like_an_envelope_is_sealed_and_opens_to_itself() {
        let key = installed(3);
        let shaped = r#"{"version":1,"nonce":"AAAA","ciphertext":"AAAA"}"#;
        let mut written = sealed_title(&key, shaped);
        assert_ne!(written["title"], json!(shaped), "a write seals it");
        open_object("agent_conversation", &mut written, &key).unwrap();
        assert_eq!(written["title"], json!(shaped));
    }

    /// A value a write sealed is never read as plain: under another key, at a
    /// version this build does not read, or not an envelope at all, it is an
    /// error, and a sealed-pending payload is the wire value as stored.
    #[test]
    fn a_value_that_does_not_open_is_an_error_whatever_its_shape() {
        let key = installed(3);
        let foreign = sealed_title(&installed(9), "Plan");
        let mut v2: Value =
            serde_json::from_str(sealed_title(&key, "Plan")["title"].as_str().unwrap()).unwrap();
        v2["version"] = json!(2);
        let cases = [
            (foreign, "another key"),
            (object(json!({"title": v2.to_string()})), "version 2"),
            (
                object(json!({"title": r#"{"version":1,"nonce":"AAAA","ciphertext":"AAAA"}"#})),
                "shaped",
            ),
            (object(json!({"title": "Plan"})), "plain"),
        ];
        for (stored, case) in cases {
            let mut opened = stored.clone();
            let error = open_object("agent_conversation", &mut opened, &key).expect_err(case);
            assert!(
                !matches!(error, SealError::KeyUnavailable),
                "{case}: {error}"
            );
            let text = Value::Object(stored.clone()).to_string();
            assert!(
                open_payload("agent_conversation", &text, false, &key).is_err(),
                "{case}"
            );
            assert_eq!(
                open_payload("agent_conversation", &text, true, &key).unwrap(),
                None,
                "{case}: pending is sent as stored"
            );
        }
        assert!(matches!(
            open_object(
                "agent_conversation",
                &mut object(json!({"title": v2.to_string()})),
                &key
            ),
            Err(SealError::UnsupportedVersion(2))
        ));
    }

    #[test]
    fn without_a_key_neither_a_seal_nor_an_open_succeeds() {
        let sealed = sealed_title(&installed(3), "Plan");
        let no_key = AtRestKey::default();
        let mut stored = object(json!({"title": "Plan"}));
        assert!(matches!(
            seal_object("agent_conversation", &mut stored, &no_key),
            Err(SealError::KeyUnavailable)
        ));
        assert!(matches!(
            open_object("agent_conversation", &mut sealed.clone(), &no_key),
            Err(SealError::KeyUnavailable)
        ));
    }
}
