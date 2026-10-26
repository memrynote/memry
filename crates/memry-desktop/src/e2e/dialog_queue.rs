//! The answers a spec gives to native dialogs. A spec never opens a native dialog, because
//! WebDriver cannot click one; the shell asks this queue first when the e2e gate is open.
//!
//! The queue holds, per dialog kind, answers in push order. An empty answer is the user
//! cancelling. A `Confirm` answer is the string `confirm` or `cancel`. A start-up queue comes
//! from `MEMRY_TEST_DIALOG_RESULT`: the plain string `confirm` or `cancel` answers every
//! `Confirm` for the whole run (a repeated prompt gets the same answer), and a JSON list of
//! `{ "kind": "OpenFolder", "paths": ["/tmp/x"] }` objects is queued in order.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use serde::Deserialize;

use crate::launch_env::LaunchEnv;

pub const DIALOG_RESULT_VAR: &str = "MEMRY_TEST_DIALOG_RESULT";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
pub enum DialogKind {
    OpenFile,
    OpenFolder,
    SaveFile,
    Confirm,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum QueueError {
    #[error(
        "MEMRY_TEST_DIALOG_RESULT is neither `confirm`, `cancel` nor a JSON list of answers: {0}"
    )]
    Malformed(String),
}

#[derive(Debug, Deserialize)]
struct Entry {
    kind: DialogKind,
    #[serde(default)]
    paths: Vec<PathBuf>,
}

#[derive(Default)]
struct State {
    queued: HashMap<DialogKind, VecDeque<Vec<PathBuf>>>,
    /// Answers every `Confirm` the queue has no pushed answer for.
    standing_confirm: Option<bool>,
}

#[derive(Default)]
pub struct DialogQueue {
    state: Mutex<State>,
}

fn confirm_answer(confirmed: bool) -> Vec<PathBuf> {
    vec![PathBuf::from(if confirmed { "confirm" } else { "cancel" })]
}

impl DialogQueue {
    /// The queue a run starts with, from `MEMRY_TEST_DIALOG_RESULT`.
    pub fn from_env(env: &LaunchEnv) -> Result<Self, QueueError> {
        let queue = Self::default();
        let Some(raw) = env.get(DIALOG_RESULT_VAR).map(str::trim) else {
            return Ok(queue);
        };
        match raw {
            "" => {}
            "confirm" => queue.lock().standing_confirm = Some(true),
            "cancel" => queue.lock().standing_confirm = Some(false),
            json => {
                let entries: Vec<Entry> = serde_json::from_str(json)
                    .map_err(|error| QueueError::Malformed(error.to_string()))?;
                for entry in entries {
                    queue.push(entry.kind, entry.paths);
                }
            }
        }
        Ok(queue)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn push(&self, kind: DialogKind, paths: Vec<PathBuf>) {
        self.lock().queued.entry(kind).or_default().push_back(paths);
    }

    pub fn clear(&self) {
        let mut state = self.lock();
        state.queued.clear();
        state.standing_confirm = None;
    }

    /// The next answer for `kind`, or `None` when nothing was queued (the caller treats that
    /// as a cancel and logs it, so a forgotten push cannot hang a spec on a real dialog).
    pub fn take(&self, kind: DialogKind) -> Option<Vec<PathBuf>> {
        let mut state = self.lock();
        if let Some(answer) = state.queued.get_mut(&kind).and_then(VecDeque::pop_front) {
            return Some(answer);
        }
        match (kind, state.standing_confirm) {
            (DialogKind::Confirm, Some(confirmed)) => Some(confirm_answer(confirmed)),
            _ => None,
        }
    }

    /// [`DialogQueue::take`] for a `Confirm`: `Some(true)` for `confirm`, `Some(false)` for
    /// `cancel` or an empty answer, `None` when nothing is queued.
    pub fn take_confirm(&self) -> Option<bool> {
        let answer = self.take(DialogKind::Confirm)?;
        Some(
            answer
                .first()
                .is_some_and(|word| word.as_os_str() == "confirm"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_with(value: &str) -> LaunchEnv {
        let mut env = LaunchEnv::default();
        env.set(DIALOG_RESULT_VAR, value);
        env
    }

    #[test]
    fn answers_come_back_per_kind_in_push_order() {
        let queue = DialogQueue::default();
        queue.push(DialogKind::OpenFolder, vec![PathBuf::from("/a")]);
        queue.push(DialogKind::OpenFolder, vec![]);
        queue.push(DialogKind::SaveFile, vec![PathBuf::from("/s")]);
        assert_eq!(
            queue.take(DialogKind::OpenFolder),
            Some(vec![PathBuf::from("/a")])
        );
        assert_eq!(queue.take(DialogKind::OpenFolder), Some(vec![]));
        assert_eq!(queue.take(DialogKind::OpenFolder), None);
        assert_eq!(
            queue.take(DialogKind::SaveFile),
            Some(vec![PathBuf::from("/s")])
        );
        assert_eq!(queue.take(DialogKind::OpenFile), None);
    }

    #[test]
    fn the_env_word_answers_every_confirm_and_a_push_goes_first() {
        let queue = DialogQueue::from_env(&env_with("confirm")).expect("queue");
        queue.push(DialogKind::Confirm, confirm_answer(false));
        assert_eq!(queue.take_confirm(), Some(false));
        assert_eq!(queue.take_confirm(), Some(true));
        assert_eq!(queue.take_confirm(), Some(true));
        let cancel = DialogQueue::from_env(&env_with("cancel")).expect("queue");
        assert_eq!(cancel.take_confirm(), Some(false));
        assert_eq!(DialogQueue::default().take_confirm(), None);
    }

    #[test]
    fn a_json_list_is_queued_in_order_and_garbage_is_refused() {
        let queue = DialogQueue::from_env(&env_with(
            r#"[{"kind":"OpenFolder","paths":["/v"]},{"kind":"OpenFolder"}]"#,
        ))
        .expect("queue");
        assert_eq!(
            queue.take(DialogKind::OpenFolder),
            Some(vec![PathBuf::from("/v")])
        );
        assert_eq!(queue.take(DialogKind::OpenFolder), Some(vec![]));
        assert!(DialogQueue::from_env(&env_with("maybe")).is_err());
        assert!(DialogQueue::from_env(&LaunchEnv::default()).is_ok());
    }

    #[test]
    fn clear_drops_everything() {
        let queue = DialogQueue::from_env(&env_with("confirm")).expect("queue");
        queue.push(DialogKind::OpenFile, vec![PathBuf::from("/f")]);
        queue.clear();
        assert_eq!(queue.take(DialogKind::OpenFile), None);
        assert_eq!(queue.take_confirm(), None);
    }
}
