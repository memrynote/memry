//! The realtime socket's frames (chapter 09 §9.5), turned into what the supervisor does. Every
//! frame is advisory: a hint wakes a pass, it never carries the change itself (§9.11).

use std::sync::Arc;

use memry_core::sync::socket::{Hint, HintSink};
use tokio::sync::mpsc;

use super::signals::{AuthSignal, Signals};
use super::supervisor::Command;

/// What one frame asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Route {
    /// Run the engine's wake past `cursor`.
    Wake(Option<i64>),
    /// The server says this device is revoked (`engine.ts` `error` arm).
    Revoked,
    Signal(AuthSignal),
    Nothing,
}

pub(super) fn route(hint: Hint) -> Route {
    match hint {
        Hint::ChangesAvailable { cursor, .. } => Route::Wake(cursor),
        // The pass reads the note-body feed, which serves every body row above the applied
        // cursor; the frame's cursor only skips a wake this device already applied (#2421).
        Hint::CrdtUpdated { cursor, .. } => Route::Wake(cursor),
        Hint::LinkingRequest {
            session_id,
            new_device_name,
            new_device_platform,
        } => Route::Signal(AuthSignal::LinkingRequest {
            session_id,
            new_device_name,
            new_device_platform,
        }),
        Hint::LinkingApproved { session_id } => {
            Route::Signal(AuthSignal::LinkingApproved { session_id })
        }
        Hint::Error { code, .. } if code.as_deref() == Some("AUTH_DEVICE_REVOKED") => {
            Route::Revoked
        }
        Hint::Error { code, message } => {
            tracing::warn!(?code, ?message, "the sync socket reported an error");
            Route::Nothing
        }
        // Calendar sync is not ported yet; it polls on its own schedule.
        Hint::CalendarChangesAvailable { source_id } => {
            tracing::debug!(%source_id, "calendar changes available");
            Route::Nothing
        }
        Hint::AuthOk { exp } => {
            tracing::debug!(?exp, "the sync socket re-authenticated");
            Route::Nothing
        }
        Hint::Ignored => Route::Nothing,
    }
}

/// The socket's sink. Synchronous by the core's contract: it forwards and returns.
pub(super) struct FrameSink {
    pub(super) commands: mpsc::WeakUnboundedSender<Command>,
    pub(super) signals: Arc<Signals>,
}

impl HintSink for FrameSink {
    fn hint(&self, hint: Hint) {
        let command = match route(hint) {
            Route::Wake(cursor) => Command::Wake(cursor),
            Route::Revoked => Command::Revoked,
            Route::Signal(signal) => return self.signals.send(signal),
            Route::Nothing => return,
        };
        if let Some(commands) = self.commands.upgrade() {
            let _ = commands.send(command);
        }
    }
}

#[cfg(test)]
mod tests {
    use memry_core::sync::socket::parse_frame;

    use super::*;

    fn frame(bytes: &str) -> Route {
        route(parse_frame(bytes.as_bytes()).expect("an envelope"))
    }

    #[test]
    fn each_frame_routes_to_its_action() {
        assert_eq!(
            frame(r#"{"type":"changes_available","payload":{"cursor":7}}"#),
            Route::Wake(Some(7))
        );
        assert_eq!(frame(r#"{"type":"changes_available"}"#), Route::Wake(None));
        assert_eq!(
            frame(r#"{"type":"crdt_updated","payload":{"noteId":"n1","cursor":9}}"#),
            Route::Wake(Some(9))
        );
        assert_eq!(
            frame(r#"{"type":"crdt_updated","payload":{"noteId":"n1"}}"#),
            Route::Wake(None)
        );
        assert_eq!(
            frame(
                r#"{"type":"linking_request","payload":{"sessionId":"s","newDeviceName":"Phone","newDevicePlatform":"ios"}}"#
            ),
            Route::Signal(AuthSignal::LinkingRequest {
                session_id: "s".into(),
                new_device_name: "Phone".into(),
                new_device_platform: "ios".into(),
            })
        );
        assert_eq!(
            frame(r#"{"type":"linking_approved","payload":{"sessionId":"s"}}"#),
            Route::Signal(AuthSignal::LinkingApproved {
                session_id: "s".into()
            })
        );
        assert_eq!(
            frame(r#"{"type":"error","payload":{"code":"AUTH_DEVICE_REVOKED"}}"#),
            Route::Revoked
        );
        for quiet in [
            r#"{"type":"error","payload":{"code":"WS_RATE_LIMITED"}}"#,
            r#"{"type":"calendar_changes_available","payload":{"sourceId":"c"}}"#,
            r#"{"type":"auth_ok","payload":{"exp":1}}"#,
            r#"{"type":"something_new"}"#,
        ] {
            assert_eq!(frame(quiet), Route::Nothing, "{quiet}");
        }
    }
}
