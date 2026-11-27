//! The end of a Readwise run, however it ended (`sync-service.ts` `finally`): the engine is
//! idle again, the status other devices read is published, and a run that changed something
//! gets its activity line (D19).

use std::sync::atomic::Ordering;

use super::engine::Engine;
use super::library::Library;
use super::run_state::RunState;
use super::run_types::{RunObserver, RunResult};
use super::status_publish::publish_run_status;
use crate::vault::activity::{ActivityInput, ActivityKind, ActivitySource};

const SCOPE: &str = "Readwise:Sync";

/// Held for the run: dropping it (a panic too) clears the stop token and the progress, then
/// frees the engine for the next run.
pub(super) struct Running<'a>(pub(super) &'a Engine);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        let engine = self.0;
        *engine.stop.lock().unwrap_or_else(|e| e.into_inner()) = None;
        engine.status().set_progress(None, false);
        engine.running.store(false, Ordering::SeqCst);
    }
}

/// The status publish and the activity line. `now` is epoch milliseconds.
pub(super) fn end_run(
    library: &Library,
    state: &RunState,
    observer: &dyn RunObserver,
    result: &RunResult,
    claim_moved: bool,
    now: i64,
) {
    // Also for a cancelled or failed run: the notes it wrote did change.
    let books = result.counts.added + result.counts.updated + result.counts.appended;
    let changed = books + result.documents;
    if !claim_moved && let Err(error) = publish_run_status(library, state, changed > 0, now) {
        tracing::warn!(
            scope = SCOPE,
            "the Readwise status could not be published: {error}"
        );
    }
    if changed > 0 && observer.log_activity() {
        record_activity(library, books, result);
    }
}

fn record_activity(library: &Library, books: u64, result: &RunResult) {
    let plural = |count: u64, noun: &str| match count {
        1 => format!("{count} {noun}"),
        _ => format!("{count} {noun}s"),
    };
    let mut message = format!(
        "Readwise: {}, {}",
        plural(books, "book"),
        plural(result.counts.highlights, "highlight")
    );
    if result.documents > 0 {
        message.push_str(&format!(
            ", {}",
            plural(result.documents, "Reader document")
        ));
    }
    let mut input = ActivityInput::new(ActivityKind::Import, ActivitySource::Import);
    input.importer = Some("readwise".to_owned());
    input.message = Some(message);
    input.counts = Some(vec![
        ("imported".to_owned(), books + result.documents),
        ("failed".to_owned(), result.counts.failed),
    ]);
    library.activity.record(&library.open.path, input);
}
