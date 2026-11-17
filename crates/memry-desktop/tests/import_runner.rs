//! `ImportRunner` (`runner.ts`): the throttle on its own clock, cancel, one run per vault at a
//! time, the final `done` snapshot and the activity log line a run leaves in the vault.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use memry_desktop::import::messages::ImportText;
use memry_desktop::import::runner::{Clock, ImportRunner, RunRequest, RunTarget};
use memry_desktop::import::{
    ImportContext, ImportError, ImportInput, ImportPhase, ImportProgress, ImportSink,
    ImportSummary, Importer, ImporterMeta, Registry,
};
use memry_desktop::vault::activity::{ActivityEntry, ActivityFilter, ActivityKind, ActivityLog};

use crate::import_support::{RecordingSink, Timeline};

type Script = dyn Fn(&ImportInput, &mut ImportContext) -> Result<(), ImportError> + Send + Sync;

/// An importer that runs a test's script.
struct ScriptImporter(Box<Script>);

impl Importer for ScriptImporter {
    fn meta(&self) -> ImporterMeta {
        serde_json::from_value(serde_json::json!({
            "id": "script",
            "name": "Script",
            "descriptionKey": "import.sources.script",
            "fileSpec": { "label": "", "extensions": [], "allowMultiple": false },
            "supportsPreview": false,
            "accountBased": false,
        }))
        .unwrap()
    }

    fn run(
        &self,
        input: &ImportInput,
        ctx: &mut ImportContext,
        _sink: &dyn ImportSink,
    ) -> Result<(), ImportError> {
        (self.0)(input, ctx)
    }
}

fn runner(
    script: impl Fn(&ImportInput, &mut ImportContext) -> Result<(), ImportError> + Send + Sync + 'static,
    clock: Clock,
) -> Arc<ImportRunner> {
    let mut registry = Registry::new();
    registry
        .register(Arc::new(ScriptImporter(Box::new(script))))
        .unwrap();
    Arc::new(ImportRunner::with_clock(Arc::new(registry), clock))
}

fn fixed_clock() -> Clock {
    Arc::new(|| 0)
}

/// A run of the script importer; the script reads `import_id` as its only source path.
fn request(import_id: &str) -> RunRequest {
    RunRequest {
        import_id: import_id.to_owned(),
        importer_id: "script".to_owned(),
        input: ImportInput {
            source_paths: vec![import_id.to_owned()],
            options: None,
        },
    }
}

fn target(root: &Path, activity: Option<Arc<ActivityLog>>) -> RunTarget {
    RunTarget {
        vault_root: root.to_path_buf(),
        sink: Arc::new(RecordingSink::new(Timeline::default())),
        activity,
    }
}

type Received = Arc<Mutex<Vec<ImportProgress>>>;

fn recorder() -> (Received, impl Fn(ImportProgress) + Send + Sync + 'static) {
    let received = Received::default();
    let sink = Arc::clone(&received);
    (received, move |snapshot| {
        sink.lock().unwrap().push(snapshot)
    })
}

/// The entries the vault's log holds on disk, read by a fresh log.
fn logged(root: &Path) -> Vec<ActivityEntry> {
    let reopened = ActivityLog::new();
    reopened.open(root);
    reopened.list(100, ActivityFilter::All).entries
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_is_throttled_on_the_runner_clock_and_done_carries_the_summary() {
    let now = Arc::new(AtomicU64::new(0));
    let clock_now = Arc::clone(&now);
    let script_now = Arc::clone(&now);
    let runner = runner(
        move |_, ctx| {
            ctx.set_phase(ImportPhase::Importing);
            for _ in 0..5 {
                ctx.report_imported();
            }
            script_now.store(99, Ordering::SeqCst);
            ctx.report_imported();
            script_now.store(100, Ordering::SeqCst);
            ctx.report_imported();
            ctx.report_imported();
            Ok(())
        },
        Arc::new(move || clock_now.load(Ordering::SeqCst)),
    );
    let dir = tempfile::tempdir().unwrap();
    let (received, on_progress) = recorder();

    let summary = runner
        .run(request("throttle"), target(dir.path(), None), on_progress)
        .await
        .unwrap();

    let received = received.lock().unwrap();
    let seen: Vec<(ImportPhase, usize, bool)> = received
        .iter()
        .map(|s| (s.phase, s.imported, s.done))
        .collect();
    // The phase change passes, the snapshots inside 100 ms drop, the first one at 100 ms
    // passes, and `done` always does.
    assert_eq!(
        seen,
        [
            (ImportPhase::Importing, 0, false),
            (ImportPhase::Importing, 7, false),
            (ImportPhase::Done, 8, true),
        ]
    );
    assert_eq!(summary.imported, 8);
    assert_eq!(received.last().unwrap().summary.as_ref(), Some(&summary));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_stops_the_run_and_logs_it_canceled() {
    let (started_tx, started_rx) = mpsc::channel();
    let started_tx = Mutex::new(started_tx);
    let runner = runner(
        move |_, ctx| {
            ctx.report_imported();
            started_tx.lock().unwrap().send(()).unwrap();
            while !ctx.is_cancelled() {
                std::thread::yield_now();
            }
            Ok(())
        },
        fixed_clock(),
    );
    let dir = tempfile::tempdir().unwrap();
    let log = ActivityLog::new();
    log.open(dir.path());

    let run = tokio::spawn({
        let runner = Arc::clone(&runner);
        let target = target(dir.path(), Some(Arc::clone(&log)));
        async move { runner.run(request("cancel"), target, |_| {}).await }
    });
    tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
        .await
        .unwrap();
    runner.cancel("cancel");
    let summary = run.await.unwrap().unwrap();
    assert_eq!(summary.imported, 1);

    log.flush().unwrap();
    let entries = logged(dir.path());
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].kind, ActivityKind::Import);
    assert_eq!(entries[0].reason.as_deref(), Some("import-canceled"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_run_into_the_same_vault_waits_for_the_first() {
    let (started_tx, started_rx) = mpsc::channel::<String>();
    let (gate_tx, gate_rx) = mpsc::channel::<()>();
    let (started_tx, gate_rx) = (Mutex::new(started_tx), Mutex::new(gate_rx));
    let runner = runner(
        move |input, _| {
            let name = input.source_paths[0].clone();
            started_tx.lock().unwrap().send(name.clone()).unwrap();
            if name == "a" {
                gate_rx.lock().unwrap().recv().unwrap();
            }
            Ok(())
        },
        fixed_clock(),
    );
    let started = Arc::new(Mutex::new(started_rx));
    let next_start = |wait: Option<Duration>| {
        let started = Arc::clone(&started);
        tokio::task::spawn_blocking(move || {
            let started = started.lock().unwrap();
            match wait {
                Some(wait) => started.recv_timeout(wait).ok(),
                None => started.recv().ok(),
            }
        })
    };
    let (vault, other) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let spawn_run = |id: &'static str, root: &Path| {
        let runner = Arc::clone(&runner);
        let target = target(root, None);
        tokio::spawn(async move { runner.run(request(id), target, |_| {}).await })
    };

    let a = spawn_run("a", vault.path());
    assert_eq!(next_start(None).await.unwrap().as_deref(), Some("a"));
    let b = spawn_run("b", vault.path());
    // Absent while `a` holds the vault.
    assert_eq!(
        next_start(Some(Duration::from_millis(300))).await.unwrap(),
        None
    );
    // Another vault does not wait.
    let c = spawn_run("c", other.path());
    assert_eq!(next_start(None).await.unwrap().as_deref(), Some("c"));
    c.await.unwrap().unwrap();

    gate_tx.send(()).unwrap();
    a.await.unwrap().unwrap();
    assert_eq!(next_start(None).await.unwrap().as_deref(), Some("b"));
    b.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_leaves_one_activity_line_naming_its_failed_and_skipped_items() {
    let runner = runner(
        |input, ctx| {
            if input.source_paths[0] == "broken" {
                return Err(ImportError::Io(std::io::Error::other("folder unreadable")));
            }
            ctx.report_imported();
            ctx.report_attachment();
            ctx.report_failed("a.md", "boom");
            ctx.report_skipped("b.png", Some(ImportText::from("Asset file not found")));
            ctx.report_skipped("c.png", None);
            Ok(())
        },
        fixed_clock(),
    );
    let dir = tempfile::tempdir().unwrap();
    let log = ActivityLog::new();
    log.open(dir.path());
    let target = || target(dir.path(), Some(Arc::clone(&log)));

    let (received, on_progress) = recorder();
    let summary: ImportSummary = runner
        .run(request("ok"), target(), on_progress)
        .await
        .unwrap();
    assert_eq!(
        (
            summary.imported,
            summary.attachments,
            summary.skipped,
            summary.failed.len()
        ),
        (1, 1, 2, 1)
    );
    assert!(received.lock().unwrap().last().unwrap().done);

    let (received, on_progress) = recorder();
    let failed = runner.run(request("broken"), target(), on_progress).await;
    assert!(matches!(failed, Err(ImportError::Io(_))), "{failed:?}");
    assert!(
        received.lock().unwrap().last().unwrap().done,
        "a failed run still sends done"
    );

    log.flush().unwrap();
    let entries = logged(dir.path());
    assert_eq!(entries.len(), 2, "{entries:?}");
    let run = entries
        .iter()
        .find(|e| e.kind == ActivityKind::Import)
        .unwrap();
    assert_eq!(run.importer.as_deref(), Some("script"));
    assert_eq!(run.reason, None);
    let counts = run.counts.as_ref().unwrap();
    let count = |key: &str| counts.get(key).copied();
    assert_eq!(
        [
            count("imported"),
            count("attachments"),
            count("skipped"),
            count("failed")
        ],
        [Some(1.0), Some(1.0), Some(2.0), Some(1.0)]
    );
    assert_eq!(
        run.items.as_deref().unwrap(),
        [
            "a.md \u{2014} boom",
            "b.png \u{2014} Asset file not found",
            "c.png"
        ]
    );
    let broken = entries
        .iter()
        .find(|e| e.kind == ActivityKind::Failed)
        .unwrap();
    assert_eq!(broken.reason.as_deref(), Some("import-failed"));
    assert_eq!(broken.message.as_deref(), Some("folder unreadable"));
    assert_eq!(broken.importer.as_deref(), Some("script"));
}
