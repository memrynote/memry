//! Chapter 09's frames: [`Hint`], and [`parse_frame`], which turns one socket
//! message into one hint (§9.5, §9.12).
//!
//! Split out of [`super::socket`], which owns the connection, its lifecycle and
//! reconnection, and re-exports both names. Nothing here holds state.

use serde_json::Value as Json;

use super::socket::KEEPALIVE_FRAME;

/// One advisory wake-up, §9.5.
///
/// Every variant means "run the ordinary pull", except the two linking frames,
/// which are how a device learns a linking session moved on (chapter 03), and
/// the two housekeeping ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hint {
    /// Run a record pull (chapter 05).
    ChangesAvailable {
        vault_id: Option<String>,
        /// Compared against the applied cursor to drop a wake this device has
        /// already applied, and never stored: §9.11 forbids using it as the
        /// device cursor.
        cursor: Option<i64>,
    },
    /// Run a body pull for this document (chapter 07).
    CrdtUpdated {
        note_id: String,
        vault_id: Option<String>,
        /// The highest cursor the write reserved (#2420), absent when it stored
        /// nothing new. Never stored: §9.11 forbids using it as the device cursor.
        cursor: Option<i64>,
    },
    CalendarChangesAvailable {
        source_id: String,
    },
    /// §9.5.1: advisory, and a client MUST also poll (chapter 03 §3.4).
    LinkingRequest {
        session_id: String,
        new_device_name: String,
        new_device_platform: String,
    },
    LinkingApproved {
        session_id: String,
    },
    /// The in-place re-auth reply, §9.8.
    AuthOk {
        exp: Option<i64>,
    },
    /// `WS_RATE_LIMITED` or `WS_TOKEN_EXPIRED`, §9.5.
    Error {
        code: Option<String>,
        message: Option<String>,
    },
    /// §9.12's single ignored outcome: the keepalive answer, a type with no
    /// handler, and a known type whose payload does not carry what it needs.
    /// **Never a throw and never a reconnect.**
    Ignored,
}

/// §9.12's parse. `None` means the bytes were not a message envelope at all,
/// which is the only case worth logging.
pub fn parse_frame(payload: &[u8]) -> Option<Hint> {
    // §9.6: the keepalive answer is not an envelope and is not a failure.
    if payload == b"pong" || payload == KEEPALIVE_FRAME {
        return Some(Hint::Ignored);
    }
    let frame: Json = serde_json::from_slice(payload).ok()?;
    let kind = frame.get("type").and_then(Json::as_str)?;
    let payload = frame.get("payload");
    let text = |key: &str| {
        payload
            .and_then(|p| p.get(key))
            .and_then(Json::as_str)
            .map(str::to_owned)
    };

    Some(match kind {
        "changes_available" => Hint::ChangesAvailable {
            vault_id: text("vaultId"),
            cursor: payload.and_then(|p| p.get("cursor")).and_then(Json::as_i64),
        },
        "crdt_updated" => match text("noteId") {
            Some(note_id) => Hint::CrdtUpdated {
                note_id,
                vault_id: text("vaultId"),
                cursor: payload.and_then(|p| p.get("cursor")).and_then(Json::as_i64),
            },
            // §9.12: a known type whose payload does not carry what it needs
            // is ignored, not rejected.
            None => Hint::Ignored,
        },
        "calendar_changes_available" => match text("sourceId") {
            Some(source_id) => Hint::CalendarChangesAvailable { source_id },
            None => Hint::Ignored,
        },
        "linking_request" => match (
            text("sessionId"),
            text("newDeviceName"),
            text("newDevicePlatform"),
        ) {
            (Some(session_id), Some(new_device_name), Some(new_device_platform)) => {
                Hint::LinkingRequest {
                    session_id,
                    new_device_name,
                    new_device_platform,
                }
            }
            _ => Hint::Ignored,
        },
        "linking_approved" => match text("sessionId") {
            Some(session_id) => Hint::LinkingApproved { session_id },
            None => Hint::Ignored,
        },
        "auth_ok" => Hint::AuthOk {
            exp: payload.and_then(|p| p.get("exp")).and_then(Json::as_i64),
        },
        "error" => Hint::Error {
            code: text("code"),
            message: text("message"),
        },
        // §9.5.2: `heartbeat` is dead — no producer, and its absence is not a
        // liveness signal. It arrives here as an unknown name and is ignored,
        // which is exactly right.
        _ => Hint::Ignored,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_type_parses_and_is_ignored_rather_than_rejected() {
        // §9.4: `type` is a plain string so a newer server can add one.
        assert_eq!(
            parse_frame(br#"{"type":"something_new","payload":{"a":1}}"#),
            Some(Hint::Ignored)
        );
        // §9.5.2: `heartbeat` is dead and arrives, if ever, as exactly this.
        assert_eq!(parse_frame(br#"{"type":"heartbeat"}"#), Some(Hint::Ignored));
        // §9.12: a known type missing what it needs is ignored too.
        assert_eq!(
            parse_frame(br#"{"type":"crdt_updated","payload":{}}"#),
            Some(Hint::Ignored)
        );
        // §9.12: `None` only when it is not an envelope at all.
        assert_eq!(parse_frame(b"not json"), None);
        assert_eq!(parse_frame(br#"{"payload":{}}"#), None);
    }

    #[test]
    fn a_changes_available_frame_carries_its_cursor_for_the_skip_filter() {
        // #2290: the cursor rides along only so the engine can drop a wake it
        // has already applied; §9.11 still forbids storing it.
        let hint = parse_frame(br#"{"type":"changes_available","payload":{"cursor":99}}"#);
        assert_eq!(
            hint,
            Some(Hint::ChangesAvailable {
                vault_id: None,
                cursor: Some(99)
            })
        );
        // §9.11: a broadcast without a cursor is still a wake.
        assert_eq!(
            parse_frame(br#"{"type":"changes_available","payload":{"vaultId":"v"}}"#),
            Some(Hint::ChangesAvailable {
                vault_id: Some("v".into()),
                cursor: None
            })
        );
    }

    #[test]
    fn a_crdt_updated_frame_carries_the_cursor_its_write_reserved() {
        // #2420: exposed for the wake filter; §9.11 forbids storing it.
        assert_eq!(
            parse_frame(
                br#"{"type":"crdt_updated","payload":{"noteId":"n","vaultId":"v","cursor":43}}"#
            ),
            Some(Hint::CrdtUpdated {
                note_id: "n".into(),
                vault_id: Some("v".into()),
                cursor: Some(43)
            })
        );
        // A duplicate-only retry and an old server send none.
        assert_eq!(
            parse_frame(br#"{"type":"crdt_updated","payload":{"noteId":"n"}}"#),
            Some(Hint::CrdtUpdated {
                note_id: "n".into(),
                vault_id: None,
                cursor: None
            })
        );
    }

    #[test]
    fn the_three_undeclared_payloads_are_read_from_their_producers() {
        // §9.5.1: the contract has no schema for these; the shapes are the
        // producers'.
        assert_eq!(
            parse_frame(
                br#"{"type":"linking_request","payload":{"sessionId":"s","newDeviceName":"iPhone","newDevicePlatform":"ios"}}"#
            ),
            Some(Hint::LinkingRequest {
                session_id: "s".into(),
                new_device_name: "iPhone".into(),
                new_device_platform: "ios".into(),
            })
        );
        assert_eq!(
            parse_frame(br#"{"type":"linking_approved","payload":{"sessionId":"s"}}"#),
            Some(Hint::LinkingApproved {
                session_id: "s".into()
            })
        );
        assert_eq!(
            parse_frame(br#"{"type":"calendar_changes_available","payload":{"sourceId":"c"}}"#),
            Some(Hint::CalendarChangesAvailable {
                source_id: "c".into()
            })
        );
    }

    #[test]
    fn the_keepalive_answer_is_not_a_parse_failure() {
        assert_eq!(parse_frame(b"pong"), Some(Hint::Ignored));
        assert_eq!(parse_frame(KEEPALIVE_FRAME), Some(Hint::Ignored));
    }
}
