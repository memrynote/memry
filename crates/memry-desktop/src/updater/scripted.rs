//! A backend the end-to-end tests script (`MEMRY_TEST_UPDATER=scripted`): each check takes the
//! next step, a download ticks through its progress, and every install hand-off is appended to
//! a file, so a spec reads it after the app has exited. Never part of a release build.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::backend::{CheckOutcome, UpdateBackend};
use super::marker::Installer;
use super::severity::{NetworkKind, UpdateError, UpdateErrorKind};
use super::state::AvailableUpdate;

/// The file in the data directory that records every `apply` call, one JSON line each.
pub const APPLIES_FILENAME: &str = "e2e-updater-applies.jsonl";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScriptStep {
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        notes_html: Option<String>,
    },
    UpToDate,
    /// The check fails.
    Fail {
        error: ScriptedFailure,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScriptedFailure {
    /// The host cannot be resolved: a warning in a check.
    Offline,
    /// The feed answers 404: an error.
    NotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyCall {
    pub silent: bool,
    pub restart: bool,
}

pub struct ScriptedBackend {
    steps: Mutex<VecDeque<ScriptStep>>,
    applies: PathBuf,
    tick: Duration,
}

impl ScriptedBackend {
    pub fn new(data_dir: PathBuf, tick: Duration) -> Self {
        Self {
            steps: Mutex::new(VecDeque::new()),
            applies: data_dir.join(APPLIES_FILENAME),
            tick,
        }
    }

    /// Replaces the steps the next checks take. With none left a check is up to date.
    pub fn script(&self, steps: Vec<ScriptStep>) {
        *self.steps.lock().unwrap_or_else(PoisonError::into_inner) = steps.into();
    }

    /// Every `apply` this data directory saw, across launches.
    pub fn applies(&self) -> Vec<ApplyCall> {
        std::fs::read_to_string(&self.applies)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
}

impl UpdateBackend for ScriptedBackend {
    fn check(&self) -> Result<CheckOutcome, UpdateError> {
        let step = self
            .steps
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front();
        match step {
            None | Some(ScriptStep::UpToDate) => Ok(CheckOutcome::UpToDate),
            Some(ScriptStep::Available {
                version,
                notes_html,
            }) => Ok(CheckOutcome::Available(AvailableUpdate {
                release_notes: notes_html
                    .as_deref()
                    .and_then(super::notes::plain_text_release_notes),
                release_notes_html: notes_html,
                version,
                ..AvailableUpdate::default()
            })),
            Some(ScriptStep::Fail { error }) => Err(match error {
                ScriptedFailure::Offline => UpdateError::new(
                    UpdateErrorKind::Network(NetworkKind::HostNotFound),
                    "the update feed host could not be resolved",
                ),
                ScriptedFailure::NotFound => {
                    UpdateError::new(UpdateErrorKind::Status(404), "the update feed returned 404")
                }
            }),
        }
    }

    fn download(&self, progress: &dyn Fn(f64)) -> Result<(), UpdateError> {
        for percent in [0.0, 25.0, 50.0, 75.0, 100.0] {
            progress(percent);
            std::thread::sleep(self.tick);
        }
        Ok(())
    }

    fn apply(&self, silent: bool, restart: bool) -> Result<(), UpdateError> {
        let line = serde_json::to_string(&ApplyCall { silent, restart })
            .map_err(|error| UpdateError::new(UpdateErrorKind::Other, error.to_string()))?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.applies)
            .and_then(|mut file| writeln!(file, "{line}"))
            .map_err(|error| UpdateError::new(UpdateErrorKind::Other, error.to_string()))
    }

    fn installer(&self) -> Installer {
        Installer::Velopack
    }
}
