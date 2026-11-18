//! `apps/desktop/src/main/import/runner.ts`: runs, previews and cancels imports.
//!
//! One run per vault at a time: a second import into the same vault waits for the first, so
//! two never interleave their notes. The importer runs on a blocking thread. Its progress
//! reaches the caller at most [`MAX_EVENTS_PER_SECOND`] times a second, except a phase change
//! and the final `done` snapshot, which always do. After the importer returns, the run writes
//! one activity log line, lets the sink finish (the index flush), then sends `done`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use tokio_util::sync::CancellationToken;

use super::{
    ImportContext, ImportError, ImportInput, ImportPhase, ImportPreview, ImportProgress,
    ImportSink, ImportSummary, Registry,
};
use crate::vault::activity::{ActivityInput, ActivityKind, ActivityLog, ActivitySource, MAX_ITEMS};

pub const MAX_EVENTS_PER_SECOND: u64 = 10;
const MIN_GAP_MS: u64 = 1000 / MAX_EVENTS_PER_SECOND;

/// Milliseconds on a monotonic clock. The app's starts at the runner's creation; tests drive
/// their own.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Where a run writes.
pub struct RunTarget {
    /// The open vault's root: runs into one root are serialized, and its activity log gets the
    /// run's line.
    pub vault_root: PathBuf,
    pub sink: Arc<dyn ImportSink>,
    pub activity: Option<Arc<ActivityLog>>,
}

/// `RunImportInput`.
#[derive(Debug, Clone)]
pub struct RunRequest {
    pub import_id: String,
    pub importer_id: String,
    pub input: ImportInput,
}

pub struct ImportRunner {
    registry: Arc<Registry>,
    clock: Clock,
    /// The token of each run or preview in flight, by `importId`.
    active: Mutex<HashMap<String, CancellationToken>>,
    vaults: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl ImportRunner {
    pub fn new(registry: Arc<Registry>) -> Self {
        let start = Instant::now();
        let clock: Clock =
            Arc::new(move || u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX));
        Self::with_clock(registry, clock)
    }

    pub fn with_clock(registry: Arc<Registry>, clock: Clock) -> Self {
        Self {
            registry,
            clock,
            active: Mutex::new(HashMap::new()),
            vaults: Mutex::new(HashMap::new()),
        }
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// `cancelImport`: the importer stops at its next check and the run returns what it did.
    pub fn cancel(&self, import_id: &str) {
        if let Some(token) = self.active().get(import_id) {
            token.cancel();
        }
    }

    /// `runImport`. `on_progress` gets the throttled snapshots, the last one `done` with the
    /// summary, which is also the result. `Err` is a run that failed as a whole; `done` is
    /// still sent, unless the importer panicked.
    pub async fn run(
        &self,
        request: RunRequest,
        target: RunTarget,
        on_progress: impl Fn(ImportProgress) + Send + Sync + 'static,
    ) -> Result<ImportSummary, ImportError> {
        let importer = self
            .registry
            .get(&request.importer_id)
            .ok_or_else(|| ImportError::UnknownImporter(request.importer_id.clone()))?;
        let token = CancellationToken::new();
        self.active()
            .insert(request.import_id.clone(), token.clone());
        let _registered = Registered {
            runner: self,
            import_id: request.import_id.clone(),
        };

        // Owned and moved into the blocking task: the vault stays held until the importer is
        // done, even when the caller stops waiting for it.
        let serialized = self.vault_lock(&target.vault_root).lock_owned().await;

        let mut throttle = Throttle::new(Arc::clone(&self.clock));
        let emit = Box::new(move |snapshot: ImportProgress| {
            if throttle.admit(&snapshot) {
                on_progress(snapshot);
            }
        });
        let RunTarget {
            vault_root,
            sink,
            activity,
        } = target;
        let importer_id = request.importer_id.clone();
        tokio::task::spawn_blocking(move || {
            let _serialized = serialized;
            let mut ctx = ImportContext::new(request.import_id, token.clone(), emit);
            let outcome = importer.run(&request.input, &mut ctx, sink.as_ref());
            let summary = ctx.summary();
            if let Some(log) = activity {
                log.record(
                    &vault_root,
                    activity_line(&importer_id, &outcome, &summary, &ctx, token.is_cancelled()),
                );
            }
            sink.finish();
            ctx.set_phase(ImportPhase::Done);
            outcome.map(|()| summary)
        })
        .await
        .map_err(|_| ImportError::Crashed)?
    }

    /// `previewImport`: what a run would import, nothing written.
    pub async fn preview(
        &self,
        import_id: &str,
        importer_id: &str,
        input: ImportInput,
    ) -> Result<ImportPreview, ImportError> {
        let importer = self
            .registry
            .get(importer_id)
            .ok_or_else(|| ImportError::UnknownImporter(importer_id.to_owned()))?;
        if !importer.meta().supports_preview {
            return Err(ImportError::NoPreview(importer_id.to_owned()));
        }
        let token = CancellationToken::new();
        self.active().insert(import_id.to_owned(), token.clone());
        let _registered = Registered {
            runner: self,
            import_id: import_id.to_owned(),
        };
        tokio::task::spawn_blocking(move || importer.preview(&input, &token))
            .await
            .map_err(|_| ImportError::Crashed)?
    }

    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancellationToken>> {
        self.active.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn vault_lock(&self, root: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut vaults = self.vaults.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(vaults.entry(root.to_path_buf()).or_default())
    }
}

/// Drops the run's token from `active` on every exit, as `runImport`'s `finally` does.
struct Registered<'a> {
    runner: &'a ImportRunner,
    import_id: String,
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.runner.active().remove(&self.import_id);
    }
}

/// `recordImportRun`, or the `failed` line of a run that threw.
fn activity_line(
    importer_id: &str,
    outcome: &Result<(), ImportError>,
    summary: &ImportSummary,
    ctx: &ImportContext,
    cancelled: bool,
) -> ActivityInput {
    if let Err(error) = outcome {
        let mut line = ActivityInput::new(ActivityKind::Failed, ActivitySource::Import)
            .reason("import-failed")
            .message(error.to_string());
        line.importer = Some(importer_id.to_owned());
        return line;
    }
    let mut line = ActivityInput::new(ActivityKind::Import, ActivitySource::Import);
    line.importer = Some(importer_id.to_owned());
    if cancelled {
        line.reason = Some("import-canceled".to_owned());
    }
    line.counts = Some(vec![
        ("imported".to_owned(), summary.imported as u64),
        ("attachments".to_owned(), summary.attachments as u64),
        ("skipped".to_owned(), summary.skipped as u64),
        ("failed".to_owned(), summary.failed.len() as u64),
    ]);
    let items: Vec<String> = summary
        .failed
        .iter()
        .map(|failed| format!("{} \u{2014} {}", failed.item, failed.error))
        .chain(ctx.skipped_items().iter().cloned())
        .take(MAX_ITEMS)
        .collect();
    if !items.is_empty() {
        line.items = Some(items);
    }
    line
}

/// At most one snapshot per [`MIN_GAP_MS`]; a phase change and `done` always pass. A dropped
/// snapshot is superseded by the next one, which carries the whole state.
struct Throttle {
    clock: Clock,
    last_sent: Option<u64>,
    last_phase: Option<ImportPhase>,
}

impl Throttle {
    fn new(clock: Clock) -> Self {
        Self {
            clock,
            last_sent: None,
            last_phase: None,
        }
    }

    fn admit(&mut self, snapshot: &ImportProgress) -> bool {
        let now = (self.clock)();
        let forced = snapshot.done || self.last_phase != Some(snapshot.phase);
        let due = self
            .last_sent
            .is_none_or(|last| now.saturating_sub(last) >= MIN_GAP_MS);
        if !(forced || due) {
            return false;
        }
        self.last_sent = Some(now);
        self.last_phase = Some(snapshot.phase);
        true
    }
}
