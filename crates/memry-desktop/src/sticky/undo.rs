//! The sticky sends of this run that can still be undone (the undo map of `stickies/send.ts`).

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use super::drafts::StickyKind;
use super::send::Sent;

/// How long Undo stays possible after a send. The sticky offers it only while its confirmation
/// shows; past that the created item may hold edits that an undo would delete.
const UNDO_WINDOW_MS: i64 = 60 * 1000;

/// A send that can still be taken back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Undo {
    /// `Note` or `Task`: a journal append merges into a synced document and has no undo.
    pub kind: StickyKind,
    pub target_id: String,
    /// The text sent, which the restored draft gets.
    pub content: String,
    expires_at_ms: i64,
}

/// The sends of this run that can be undone, by token. Held in memory as Electron holds them: a
/// restart forgets them.
#[derive(Default)]
pub struct UndoLedger {
    entries: Mutex<HashMap<String, Undo>>,
}

impl UndoLedger {
    /// Holds a note or task send for [`UNDO_WINDOW_MS`]; `None` for a journal send.
    pub fn record(
        &self,
        kind: StickyKind,
        sent: &Sent,
        content: &str,
        now_ms: i64,
    ) -> Option<String> {
        if kind == StickyKind::Journal {
            return None;
        }
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        entries.retain(|_, undo| undo.expires_at_ms > now_ms);
        let token = uuid::Uuid::new_v4().to_string();
        entries.insert(
            token.clone(),
            Undo {
                kind,
                target_id: sent.target_id.clone(),
                content: content.to_owned(),
                expires_at_ms: now_ms + UNDO_WINDOW_MS,
            },
        );
        Some(token)
    }

    /// The send of `token` while its window is open; each token is taken once.
    pub fn take(&self, token: &str, now_ms: i64) -> Option<Undo> {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        entries.retain(|_, undo| undo.expires_at_ms > now_ms);
        entries.remove(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sent() -> Sent {
        Sent {
            target_id: "n1".to_owned(),
            title: "Milk".to_owned(),
        }
    }

    #[test]
    fn an_undo_is_taken_once_within_its_minute() {
        let ledger = UndoLedger::default();
        let token = ledger
            .record(StickyKind::Note, &sent(), "Milk", 1_000)
            .unwrap();
        let undo = ledger.take(&token, 1_000 + UNDO_WINDOW_MS - 1).unwrap();
        assert_eq!(
            (undo.kind, undo.target_id.as_str(), undo.content.as_str()),
            (StickyKind::Note, "n1", "Milk")
        );
        assert_eq!(ledger.take(&token, 1_001), None);
    }

    #[test]
    fn an_undo_past_its_minute_is_gone() {
        let ledger = UndoLedger::default();
        let token = ledger
            .record(StickyKind::Task, &sent(), "Milk", 1_000)
            .unwrap();
        assert_eq!(ledger.take(&token, 1_000 + UNDO_WINDOW_MS), None);
    }

    #[test]
    fn a_journal_send_has_no_undo() {
        let ledger = UndoLedger::default();
        assert_eq!(
            ledger.record(StickyKind::Journal, &sent(), "Milk", 1_000),
            None
        );
    }
}
