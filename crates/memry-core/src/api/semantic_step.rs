use std::path::Path;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use super::{SemanticSearch, lock};
use crate::api::errors::StorageError;
use crate::api::vault::Vault;
use crate::domain::search::source::note_text;
use crate::semantic::queue::{self, InFlight, Pace, Thermal, pace};
use crate::semantic::{ReleaseReason, SemanticError, WindowOutcome};
use crate::storage::Db;
use crate::storage::vector_db::{self, VectorStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct StepConditions {
    pub thermal: Thermal,
    pub external_power: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum StepOutcome {
    /// Not done yet. Sleep `rest_ms`, then step again.
    Embedded {
        embedded: u32,
        total: u32,
        rest_ms: u32,
    },
    /// Nothing is due: every live note is current or skipped after a failure.
    Finished { embedded: u32, total: u32 },
    /// Stop stepping until the next scheduled run.
    Stopped { reason: StepStop },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum StepStop {
    TooHot,
    OnBattery,
    MemoryPressure,
    /// Opted out, or the model is not fully downloaded.
    ModelNotReady,
    /// This binary has no ONNX Runtime.
    Unavailable,
}

fn stopped(reason: StepStop) -> StepOutcome {
    StepOutcome::Stopped { reason }
}

#[uniffi::export(async_runtime = "tokio")]
impl SemanticSearch {
    /// Runs at most one window of inference per call.
    pub async fn embed_step(
        &self,
        vault: Arc<Vault>,
        conditions: StepConditions,
    ) -> Result<StepOutcome, SemanticError> {
        let _step = self.step.lock().await;
        if self.host.take_pressure() {
            return Ok(stopped(StepStop::MemoryPressure));
        }
        if pace(conditions.thermal, Default::default()) == Pace::Stop {
            return Ok(stopped(StepStop::TooHot));
        }
        if !conditions.external_power {
            return Ok(stopped(StepStop::OnBattery));
        }
        let Some(vectors) = self.ready_vectors(vault.directory())? else {
            return Ok(stopped(StepStop::ModelNotReady));
        };
        let key = self.model.manifest().vector_key;
        let data = vault.db_handle();

        let sources = data.call(|conn| queue::sources(conn)).await?;
        let states = vectors.call(|conn| VectorStore::new(conn).states()).await?;
        let died = vectors
            .call(|conn| VectorStore::new(conn).attempts())
            .await?;
        for source_key in died {
            if lock(&self.skipped).insert(source_key) {
                eprintln!(
                    "memry-core: a note's embedding died with the process, skipped until it changes"
                );
            }
        }
        let plan = queue::plan(&sources, &states, key, &lock(&self.skipped));
        if !plan.prune.is_empty() {
            let prune = plan.prune.clone();
            vectors
                .call(move |conn| VectorStore::new(conn).prune(&prune))
                .await?;
        }

        let vault_dir = vault.directory().to_path_buf();
        let held = lock(&self.in_flight).remove(&vault_dir);
        let mut note = match (held, plan.next.clone()) {
            (Some(note), _) => note,
            (None, None) => {
                return Ok(StepOutcome::Finished {
                    embedded: plan.embedded,
                    total: plan.total,
                });
            }
            (None, Some(note_id)) => {
                let id = note_id.clone();
                match data
                    .call(move |conn| note_text(conn, &id, now_ms()))
                    .await?
                {
                    Some((title, text)) => InFlight::start(note_id, &title, &text, key),
                    None => return Ok(self.embedded(&plan, Default::default(), conditions)),
                }
            }
        };

        let started = Instant::now();
        if let Some(window) = note.next_window() {
            let input = window.as_str().to_owned();
            let (id, source_key) = (note.note_id().to_owned(), note.source_key());
            vectors
                .call(move |conn| VectorStore::new(conn).begin_attempt(&id, &source_key))
                .await?;
            let outcome = self.host.embed_background(input).await;
            let id = note.note_id().to_owned();
            vectors
                .call(move |conn| VectorStore::new(conn).end_attempt(&id))
                .await?;
            match outcome {
                Ok(WindowOutcome::Embedded(vector)) => note.push(&vector),
                Ok(WindowOutcome::InputFailed(error)) if !self.host.take_pressure() => {
                    eprintln!(
                        "memry-core: a note failed to embed, skipped until it changes: {error}"
                    );
                    lock(&self.skipped).insert(note.source_key());
                    return Ok(self.embedded(&plan, started.elapsed(), conditions));
                }
                Ok(WindowOutcome::InputFailed(_)) => {
                    lock(&self.in_flight).insert(vault_dir, note);
                    return Ok(stopped(StepStop::MemoryPressure));
                }
                Err(error) => {
                    lock(&self.in_flight).insert(vault_dir, note);
                    return self.stop_for(error);
                }
            }
        }
        let took = started.elapsed();
        let mut embedded = plan.embedded;
        if note.is_complete() {
            let (state, windows) = note.into_commit();
            vectors
                .call(move |conn| VectorStore::new(conn).replace_note(&state, &windows, now_ms()))
                .await?;
            embedded = embedded.saturating_add(1).min(plan.total);
        } else {
            lock(&self.in_flight).insert(vault_dir, note);
        }
        if self.host.take_pressure() {
            return Ok(stopped(StepStop::MemoryPressure));
        }
        let plan = queue::Plan { embedded, ..plan };
        Ok(self.embedded(&plan, took, conditions))
    }

    /// `Background` unloads unless the embedder is running. `MemoryWarning`
    /// always unloads, and the next step stops with `MemoryPressure`.
    pub fn release(&self, reason: ReleaseReason) {
        self.host.release(reason);
    }
}

impl SemanticSearch {
    fn embedded(
        &self,
        plan: &queue::Plan,
        took: std::time::Duration,
        conditions: StepConditions,
    ) -> StepOutcome {
        let rest = match pace(conditions.thermal, took) {
            Pace::Rest(rest) => rest,
            Pace::Stop => std::time::Duration::ZERO,
        };
        StepOutcome::Embedded {
            embedded: plan.embedded,
            total: plan.total,
            rest_ms: u32::try_from(rest.as_millis()).unwrap_or(u32::MAX),
        }
    }

    fn stop_for(&self, error: SemanticError) -> Result<StepOutcome, SemanticError> {
        if self.host.take_pressure() {
            return Ok(stopped(StepStop::MemoryPressure));
        }
        if !self.model.opted_in() || self.model.verified().is_none() {
            return Ok(stopped(StepStop::ModelNotReady));
        }
        match error {
            SemanticError::Unavailable => Ok(stopped(StepStop::Unavailable)),
            error => Err(error),
        }
    }

    fn ready_vectors(&self, vault_dir: &Path) -> Result<Option<Db>, StorageError> {
        let mut handles = lock(&self.vectors);
        if !self.model.opted_in() || self.model.verified().is_none() {
            return Ok(None);
        }
        let path = vault_dir.join("vectors.db");
        if !path.exists() {
            handles.remove(vault_dir);
        }
        if let Some(db) = handles.get(vault_dir) {
            return Ok(Some(db.clone()));
        }
        let Some(db) = vector_db::open(&path, true)? else {
            return Ok(None);
        };
        handles.insert(vault_dir.to_path_buf(), db.clone());
        Ok(Some(db))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
#[path = "semantic_step_tests.rs"]
mod tests;
