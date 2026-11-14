//! The embed queue: which note to embed next, how fast, and the note being
//! embedded. The only writer of `vectors.db`.
//!
//! Invariants, each held by a test in `api/semantic_step_tests.rs`:
//!
//! 1. **No stored queue.** What is due is derived on every step from `data.db`
//!    (live notes) and `vectors.db` (state rows). An edit, a rename, a delete,
//!    a new model or an input-version bump reaches the queue with no hook.
//! 2. **A note commits whole or not at all.** Its windows are embedded into
//!    memory ([`InFlight`]) and written in one `replace_note` transaction
//!    after the last one, so a kill or an expiry mid-note leaves no partial
//!    rows and costs at most that note.
//! 3. **A state row names exactly the text its vectors came from.** The
//!    source key is computed from the text the windows were cut from, so an
//!    edit at any time, during the note's own embedding included, leaves the
//!    row stale and the note due again.
//! 4. **Only live notes keep vectors.** Every step prunes the state rows of
//!    notes that left the live set.
//! 5. **A note whose inference fails is skipped, not retried.** Its source key
//!    joins a per-process set the plan passes over, so one bad note never
//!    holds up the notes behind it. It writes no state row: an edit or a
//!    rename gives it a new key and a relaunch empties the set, and either
//!    retries it. Until then its old vectors, if any, keep serving.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use rusqlite::Connection;
use sha2::{Digest as _, Sha256};

use super::Vector;
use crate::api::errors::StorageError;
use crate::domain::embedding_input::{EMBEDDING_INPUT_VERSION, Window, chunks};
use crate::domain::search::source::live_notes;
use crate::storage::vector_db::{NoteState, VectorBytes};

/// The device's thermal state, as the shell reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Thermal {
    Nominal,
    Fair,
    Serious,
    Critical,
}

pub(crate) struct NoteSource {
    pub(crate) note_id: String,
    pub(crate) source_key: [u8; 32],
}

/// `sha256(title || 0x00 || sha256(text))`. The title is part of the key
/// because every window's header carries it, so a rename re-embeds.
pub(crate) fn source_key(title: &str, text_sha256: &[u8; 32]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(title.as_bytes());
    hash.update([0]);
    hash.update(text_sha256);
    hash.finalize().into()
}

/// Every live note's source key. A note whose body was never cached gets the
/// zero key, which no state row holds, so it is always due.
pub(crate) fn sources(data: &Connection) -> Result<Vec<NoteSource>, StorageError> {
    Ok(live_notes(data)?
        .into_iter()
        .map(|note| NoteSource {
            source_key: note
                .text_sha256
                .map_or([0; 32], |sha| source_key(&note.title, &sha)),
            note_id: note.note_id,
        })
        .collect())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Plan {
    pub(crate) next: Option<String>,
    pub(crate) prune: Vec<String>,
    /// Live notes whose state row is current.
    pub(crate) embedded: u32,
    pub(crate) total: u32,
}

/// Due: no state row, or one built with another model, input version or
/// source, and not `skipped` (invariant 5). Never-embedded notes come before
/// stale ones, whose old vectors keep serving meanwhile (desktop's reconcile
/// order).
pub(crate) fn plan(
    sources: &[NoteSource],
    states: &[NoteState],
    vector_key: &str,
    skipped: &HashSet<[u8; 32]>,
) -> Plan {
    let by_id: HashMap<&str, &NoteState> = states
        .iter()
        .map(|state| (state.note_id.as_str(), state))
        .collect();
    let (mut missing, mut stale, mut embedded) = (None, None, 0u32);
    for source in sources {
        match by_id.get(source.note_id.as_str()) {
            Some(state)
                if state.vector_key == vector_key
                    && state.input_version == EMBEDDING_INPUT_VERSION
                    && state.source_key == source.source_key =>
            {
                embedded += 1;
            }
            _ if skipped.contains(&source.source_key) => {}
            None => missing = missing.or(Some(&source.note_id)),
            Some(_) => stale = stale.or(Some(&source.note_id)),
        }
    }
    let live: HashSet<&str> = sources
        .iter()
        .map(|source| source.note_id.as_str())
        .collect();
    Plan {
        next: missing.or(stale).cloned(),
        prune: states
            .iter()
            .filter(|state| !live.contains(state.note_id.as_str()))
            .map(|state| state.note_id.clone())
            .collect(),
        embedded,
        total: u32::try_from(sources.len()).unwrap_or(u32::MAX),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Pace {
    Stop,
    Rest(Duration),
}

/// Critical: stop before any work. Serious: rest as long as the last window
/// took, a 50% duty cycle. Otherwise no rest. A guess to tune once the
/// processing task is measured on a device.
pub(crate) fn pace(thermal: Thermal, last_window: Duration) -> Pace {
    match thermal {
        Thermal::Critical => Pace::Stop,
        Thermal::Serious => Pace::Rest(last_window),
        Thermal::Nominal | Thermal::Fair => Pace::Rest(Duration::ZERO),
    }
}

/// The note being embedded, in memory only. Lost on a kill (invariant 2).
pub(crate) struct InFlight {
    state: NoteState,
    windows: Vec<Window>,
    done: Vec<VectorBytes>,
}

impl InFlight {
    pub(crate) fn start(note_id: String, title: &str, text: &str, vector_key: &str) -> Self {
        let windows = chunks(title, text);
        let text_sha256: [u8; 32] = Sha256::digest(text.as_bytes()).into();
        Self {
            state: NoteState {
                note_id,
                vector_key: vector_key.to_owned(),
                input_version: EMBEDDING_INPUT_VERSION,
                source_key: source_key(title, &text_sha256),
                window_count: u32::try_from(windows.len()).unwrap_or(u32::MAX),
            },
            windows,
            done: Vec::new(),
        }
    }

    pub(crate) fn source_key(&self) -> [u8; 32] {
        self.state.source_key
    }

    pub(crate) fn next_window(&self) -> Option<&Window> {
        self.windows.get(self.done.len())
    }

    pub(crate) fn push(&mut self, vector: &Vector) {
        self.done.push(vector.to_le_bytes());
    }

    pub(crate) fn is_complete(&self) -> bool {
        self.done.len() == self.windows.len()
    }

    /// The state row and its vectors. Only a complete note commits.
    pub(crate) fn into_commit(self) -> (NoteState, Vec<VectorBytes>) {
        debug_assert!(self.is_complete());
        (self.state, self.done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str, key: u8) -> NoteSource {
        NoteSource {
            note_id: id.into(),
            source_key: [key; 32],
        }
    }

    fn state(id: &str, key: u8, vector_key: &str, input_version: u32) -> NoteState {
        NoteState {
            note_id: id.into(),
            vector_key: vector_key.into(),
            input_version,
            source_key: [key; 32],
            window_count: 1,
        }
    }

    const V: u32 = EMBEDDING_INPUT_VERSION;

    #[test]
    fn plan_table() {
        struct Case {
            name: &'static str,
            sources: Vec<NoteSource>,
            states: Vec<NoteState>,
            next: Option<&'static str>,
            prune: Vec<&'static str>,
            embedded: u32,
            skipped: Vec<u8>,
        }
        let cases = [
            Case {
                name: "empty vault",
                sources: vec![],
                states: vec![],
                next: None,
                prune: vec![],
                embedded: 0,
                skipped: vec![],
            },
            Case {
                name: "a skipped note is passed over, missing or stale",
                sources: vec![source("a", 7), source("b", 8), source("c", 3)],
                states: vec![state("b", 2, "k", V)],
                next: Some("c"),
                prune: vec![],
                embedded: 0,
                skipped: vec![7, 8],
            },
            Case {
                name: "a skipped key that is current still counts",
                sources: vec![source("a", 1)],
                states: vec![state("a", 1, "k", V)],
                next: None,
                prune: vec![],
                embedded: 1,
                skipped: vec![1],
            },
            Case {
                name: "all current",
                sources: vec![source("a", 1), source("b", 2)],
                states: vec![state("a", 1, "k", V), state("b", 2, "k", V)],
                next: None,
                prune: vec![],
                embedded: 2,
                skipped: vec![],
            },
            Case {
                name: "missing before stale, whatever the order",
                sources: vec![source("a", 9), source("b", 2)],
                states: vec![state("a", 1, "k", V)],
                next: Some("b"),
                prune: vec![],
                embedded: 0,
                skipped: vec![],
            },
            Case {
                name: "edited source is stale",
                sources: vec![source("a", 9)],
                states: vec![state("a", 1, "k", V)],
                next: Some("a"),
                prune: vec![],
                embedded: 0,
                skipped: vec![],
            },
            Case {
                name: "another model is stale",
                sources: vec![source("a", 1)],
                states: vec![state("a", 1, "old", V)],
                next: Some("a"),
                prune: vec![],
                embedded: 0,
                skipped: vec![],
            },
            Case {
                name: "an older input version is stale",
                sources: vec![source("a", 1)],
                states: vec![state("a", 1, "k", V - 1)],
                next: Some("a"),
                prune: vec![],
                embedded: 0,
                skipped: vec![],
            },
            Case {
                name: "a row whose note left is pruned",
                sources: vec![source("a", 1)],
                states: vec![state("a", 1, "k", V), state("gone", 1, "k", V)],
                next: None,
                prune: vec!["gone"],
                embedded: 1,
                skipped: vec![],
            },
        ];
        for case in cases {
            let skipped = case.skipped.iter().map(|&key| [key; 32]).collect();
            let plan = plan(&case.sources, &case.states, "k", &skipped);
            assert_eq!(plan.next.as_deref(), case.next, "{}", case.name);
            assert_eq!(plan.prune, case.prune, "{}", case.name);
            assert_eq!(plan.embedded, case.embedded, "{}", case.name);
            assert_eq!(plan.total as usize, case.sources.len(), "{}", case.name);
        }
    }

    #[test]
    fn pace_table() {
        let last = Duration::from_millis(1500);
        assert_eq!(pace(Thermal::Nominal, last), Pace::Rest(Duration::ZERO));
        assert_eq!(pace(Thermal::Fair, last), Pace::Rest(Duration::ZERO));
        assert_eq!(pace(Thermal::Serious, last), Pace::Rest(last));
        assert_eq!(pace(Thermal::Critical, last), Pace::Stop);
    }

    #[test]
    fn a_rename_changes_the_source_key_and_the_body_hash_is_separated_from_the_title() {
        let sha = [7; 32];
        assert_ne!(source_key("a", &sha), source_key("b", &sha));
        assert_ne!(source_key("a", &sha), source_key("a", &[8; 32]));
    }

    #[test]
    fn a_note_commits_only_after_its_last_window() {
        let text = "word ".repeat(2000);
        let mut note = InFlight::start("n".into(), "T", &text, "k");
        assert!(note.state.window_count >= 2);
        let vector = crate::semantic::truncate_renormalize(&[1.0; 256]).unwrap();
        note.push(&vector);
        assert!(!note.is_complete(), "one window is not the note");
        while note.next_window().is_some() {
            note.push(&vector);
        }
        assert!(note.is_complete());
        let (state, vectors) = note.into_commit();
        assert_eq!(vectors.len() as u32, state.window_count);
    }

    #[test]
    fn a_note_too_short_to_embed_commits_with_no_windows() {
        let note = InFlight::start("n".into(), "T", "short", "k");
        assert!(note.next_window().is_none());
        assert!(note.is_complete(), "nothing to embed");
        let (state, vectors) = note.into_commit();
        assert_eq!((state.window_count, vectors.len()), (0, 0));
    }
}
