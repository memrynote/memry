//! Progress of the first-launch migration. The Tauri shell implements [`ProgressSink`] over the
//! preboot page (`memryMigration.update(...)`); tests use [`ProgressRecorder`].

use std::sync::{Mutex, PoisonError};

use serde::Serialize;

/// The phases in the order they run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    AppState,
    Secrets,
    Vault,
    Finish,
}

/// One update. In the `vault` phase `current` and `total` count vaults and `label` is the vault
/// name; in `app-state` they count its steps and `label` names the step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProgressUpdate {
    pub phase: Phase,
    pub current: u32,
    pub total: u32,
    pub label: String,
}

pub trait ProgressSink: Send + Sync {
    fn update(&self, update: ProgressUpdate);
}

/// Keeps every update, in order.
#[derive(Debug, Default)]
pub struct ProgressRecorder(Mutex<Vec<ProgressUpdate>>);

impl ProgressRecorder {
    pub fn updates(&self) -> Vec<ProgressUpdate> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl ProgressSink for ProgressRecorder {
    fn update(&self, update: ProgressUpdate) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(update);
    }
}
