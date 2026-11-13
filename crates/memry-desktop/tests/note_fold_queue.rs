//! The model levels of the fold (`fold-service.ts` and `note-fold/index.ts`, Step 22 #3539)
//! over a running vault and a fake model: which status a note reads, how many chunks run at
//! once, which run again, what a vault open and close do to the cache and to the runs in
//! flight, and which notes fetch again.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use memry_core::domain::fold_chunks::ChunkKey;
use memry_desktop::fold::FoldStatus;
use memry_desktop::fold::queue::{FOLD_CONCURRENCY, FoldLastRun, LastRunStatus};
use serde_json::json;
use tokio::sync::mpsc::error::TryRecvError;

use std::sync::Arc;

use axum::http::Method;
use memry_desktop::ai::local_provider::AgentLocalProviderPreset;
use memry_desktop::fold::agent::FoldAgents;

use crate::ai_local_agent::{agent, provider};
use crate::local_agent_server::{MODEL, answer, models, serve};
use crate::note_fold_service::{Reply, chunk_keys, sectioned, valid_reply, world, world_on};

const IDLE: Duration = Duration::from_secs(30);
/// How long a test watches for something that must not happen.
const QUIET: Duration = Duration::from_millis(300);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// fold-service.ts:202-206 and :218: short, off, no_agent, writing, then ready from the cache
/// with the agent's label, and a cached chunk never runs again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_note_reads_off_then_no_agent_then_writing_then_ready_from_the_cache() {
    let text = sectioned(3, "status");
    let mut w = world(&[("a.md", &text)], IDLE);
    let id = w.id_of("a.md");

    let off = w.get(&id).await;
    assert_eq!((off.status, off.agent.as_deref()), (FoldStatus::Off, None));
    w.summarize(true);
    w.fake
        .available
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let none = w.get(&id).await;
    assert_eq!(
        (none.status, none.agent.as_deref()),
        (FoldStatus::NoAgent, None)
    );
    assert_eq!(w.fake.runs(), 0);

    w.fake
        .available
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let writing = w.get(&id).await;
    assert_eq!(writing.status, FoldStatus::Writing);
    assert_eq!(writing.agent.as_deref(), Some("Fake model"));
    let ready = w.until_status(&id, FoldStatus::Ready).await;
    assert_eq!(ready.agent.as_deref(), Some("Fake model"));
    assert_eq!(
        ready.sections[0].takeaway.as_deref(),
        Some("The section in one line.")
    );
    assert_eq!(ready.sections[0].paragraphs[1].takeaway, "Takeaway 1.");
    let runs = w.fake.runs();
    assert_eq!(runs, chunk_keys(&text).len());

    assert_eq!(w.get(&id).await.status, FoldStatus::Ready);
    assert_eq!(w.fake.runs(), runs, "a cached chunk ran again");
}

/// fold-service.ts:27 and :126: at most four chunks run at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn at_most_four_chunks_run_at_once() {
    let text = sectioned(6, "busy");
    let mut w = world(&[("a.md", &text)], IDLE);
    let id = w.id_of("a.md");
    w.summarize(true);
    w.hold_runs();

    assert_eq!(w.get(&id).await.status, FoldStatus::Writing);
    for _ in 0..FOLD_CONCURRENCY {
        w.next_start().await;
    }
    assert!(
        tokio::time::timeout(QUIET, w.started.recv()).await.is_err(),
        "a fifth chunk started while four ran"
    );
    assert_eq!(
        w.fold.last_run(),
        FoldLastRun {
            status: LastRunStatus::Writing,
            note_id: Some(id.clone()),
        }
    );
    // One finishes, and the fifth takes its slot.
    w.release(1);
    w.next_start().await;
    w.release_all();
    w.until_status(&id, FoldStatus::Ready).await;
    assert_eq!(w.fake.runs(), 6);
    assert_eq!(w.fake.peak.load(std::sync::atomic::Ordering::SeqCst), 4);
    assert_eq!(w.fold.last_run().status, LastRunStatus::Idle);
}

/// fold-service.ts:152-156 and :133: a chunk two notes ask for runs once, and both hear of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chunk_two_notes_share_runs_once_and_tells_both() {
    let text = sectioned(3, "shared");
    let mut w = world(&[("a.md", &text), ("b.md", &text)], IDLE);
    let (a, b) = (w.id_of("a.md"), w.id_of("b.md"));
    w.summarize(true);
    w.hold_runs();
    assert_eq!(w.get(&a).await.status, FoldStatus::Writing);
    assert_eq!(w.get(&b).await.status, FoldStatus::Writing);
    w.release_all();

    let mut told = Vec::new();
    while told.len() < 6 {
        told.push(w.next_update().await);
    }
    assert_eq!(told.iter().filter(|id| **id == a).count(), 3);
    assert_eq!(told.iter().filter(|id| **id == b).count(), 3);
    assert_eq!(w.get(&a).await.status, FoldStatus::Ready);
    assert_eq!(w.get(&b).await.status, FoldStatus::Ready);
    assert_eq!(w.fake.runs(), 3);
}

/// fold-service.ts:162-216: `get` reads the cache and queues what it missed in one synchronous
/// step, so a chunk never runs twice. Here a chunk can finish between the two: readers that
/// fold while chunks finish run each chunk once all the same.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_chunk_that_finishes_while_a_note_folds_runs_once() {
    let text = sectioned(12, "racing");
    let mut w = world(&[("a.md", &text)], IDLE);
    let id = w.id_of("a.md");
    w.summarize(true);
    let readers: Vec<_> = (0..6)
        .map(|_| {
            let (fold, id) = (w.fold.clone(), id.clone());
            tokio::spawn(async move {
                for _ in 0..2_000 {
                    if fold.get(&id).await.expect("fold").status == FoldStatus::Ready {
                        return;
                    }
                }
                panic!("never ready");
            })
        })
        .collect();
    for reader in readers {
        reader.await.expect("reader");
    }
    w.until_status(&id, FoldStatus::Ready).await;
    assert_eq!(w.fake.runs(), 12);
}

/// fold-service.ts:109-121, :147-150, :213-214, :224-238 and :101-108: a failed chunk is not run
/// again until a retry, the note reads failed, and the last run names it until the retry
/// writes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_chunk_waits_for_a_retry() {
    let text = sectioned(3, "failing");
    let mut w = world(&[("a.md", &text)], IDLE);
    let id = w.id_of("a.md");
    w.summarize(true);
    assert_eq!(w.fold.retry(None).await.expect("retry"), None);
    w.fake.reply([Reply::Fail, Reply::Valid, Reply::Valid]);

    w.until_status(&id, FoldStatus::Failed).await;
    assert_eq!(w.fake.runs(), 3);
    assert_eq!(w.get(&id).await.status, FoldStatus::Failed);
    assert_eq!(w.fake.runs(), 3, "a failed chunk ran again without a retry");
    assert_eq!(
        w.fold.last_run(),
        FoldLastRun {
            status: LastRunStatus::Failed,
            note_id: Some(id.clone()),
        }
    );

    let retried = w.fold.retry(None).await.expect("retry").expect("a note");
    assert_eq!(retried.status, FoldStatus::Writing);
    w.until_status(&id, FoldStatus::Ready).await;
    assert_eq!(w.fake.runs(), 4);
    assert_eq!(w.fold.last_run().status, LastRunStatus::Idle);
}

/// fold-service.ts:96-99 and :109-121 (`chunkAiSchema`): a reply of the wrong shape fails the
/// chunk and caches nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reply_of_the_wrong_shape_fails_and_caches_nothing() {
    let text = sectioned(3, "shape");
    let mut w = world(&[("a.md", &text)], IDLE);
    let id = w.id_of("a.md");
    w.summarize(true);
    let wrong = json!({ "sectionTakeaway": "One line.", "paragraphs": [] });
    w.fake.reply((0..3).map(|_| Reply::Raw(wrong.clone())));

    w.until_status(&id, FoldStatus::Failed).await;
    let search = w.search();
    for key in chunk_keys(&text) {
        assert_eq!(search.fold_chunk(&key).expect("read"), None);
    }
}

/// fold-service.ts:167-175: a cache row that does not read as its chunk's reply is deleted
/// before the chunk runs again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreadable_cache_row_is_deleted_and_written_again() {
    let text = sectioned(3, "unreadable");
    let mut w = world(&[("a.md", &text)], IDLE);
    let id = w.id_of("a.md");
    w.summarize(true);
    let keys = chunk_keys(&text);
    let search = w.search();
    search
        .put_fold_chunk(&keys[0], "{not json", now_ms())
        .expect("seed");
    w.hold_runs();

    assert_eq!(w.get(&id).await.status, FoldStatus::Writing);
    assert_eq!(search.fold_chunk(&keys[0]).expect("read"), None);
    w.release_all();
    w.until_status(&id, FoldStatus::Ready).await;
    let row = search.fold_chunk(&keys[0]).expect("read").expect("written");
    assert!(serde_json::from_str::<serde_json::Value>(&row).is_ok());
}

/// note-fold/index.ts:36 and :54-59: every open forgets the agent detection and drops the
/// cached chunks older than 90 days.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_open_forgets_the_agent_and_prunes_old_chunks() {
    let mut w = world(&[("a.md", &sectioned(3, "prune"))], IDLE);
    assert_eq!(w.fake.forgets.load(std::sync::atomic::Ordering::SeqCst), 1);
    let key = |hash: &str| ChunkKey {
        chunk_hash: hash.into(),
        language: "en".into(),
        model_id: "fake:model".into(),
    };
    let day = 24 * 60 * 60 * 1000;
    let search = w.search();
    search
        .put_fold_chunk(&key("old"), "{}", now_ms() - 91 * day)
        .expect("old");
    search
        .put_fold_chunk(&key("fresh"), "{}", now_ms() - 89 * day)
        .expect("fresh");
    drop(search);

    w.e.close();
    w.e.open();
    assert_eq!(w.fake.forgets.load(std::sync::atomic::Ordering::SeqCst), 2);
    let search = w.search();
    assert_eq!(search.fold_chunk(&key("old")).expect("read"), None);
    assert!(search.fold_chunk(&key("fresh")).expect("read").is_some());
}

/// Stated divergence from fold-service.ts:265-270: closing the vault cancels the runs in
/// flight, so a run waiting on its model writes nothing, where Electron lets them finish and
/// write into whichever index is open by then. A write already under way can still land in
/// the closing vault's own index.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_the_vault_cancels_the_runs_and_drops_their_results() {
    let text = sectioned(3, "closing");
    let mut w = world(&[("a.md", &text)], IDLE);
    let id = w.id_of("a.md");
    w.summarize(true);
    w.hold_runs();
    assert_eq!(w.get(&id).await.status, FoldStatus::Writing);
    for _ in 0..3 {
        w.next_start().await;
    }

    w.e.close();
    w.release_all();
    assert!(
        tokio::time::timeout(QUIET, w.replied.recv()).await.is_err(),
        "a run went on after the vault closed"
    );
    assert_eq!(w.fold.last_run().status, LastRunStatus::Idle);
    w.e.open();
    let search = w.search();
    for key in chunk_keys(&text) {
        assert_eq!(search.fold_chunk(&key).expect("read"), None);
    }
    assert_eq!(w.updates.try_recv(), Err(TryRecvError::Empty));
}

/// fold-service.ts:183-185 and :242-245: a note fetched before the index knew it is fetched
/// again when it is indexed, once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_note_fetched_before_it_was_indexed_is_fetched_again_once() {
    let mut w = world(&[("a.md", &sectioned(3, "unindexed"))], IDLE);
    assert_eq!(w.get("not-yet").await.status, FoldStatus::Short);
    w.fold.note_changed("not-yet");
    assert_eq!(w.updates.try_recv().as_deref(), Ok("not-yet"));
    w.fold.note_changed("not-yet");
    assert_eq!(w.updates.try_recv(), Err(TryRecvError::Empty));
}

/// fold-service.ts:260-263 and note-fold/index.ts:69-72: a refresh fetches every note the
/// renderer fetched again, and nothing once the vault closed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refresh_fetches_every_fetched_note_again() {
    let mut w = world(&[("a.md", &sectioned(3, "refresh"))], IDLE);
    let id = w.id_of("a.md");
    w.get(&id).await;
    w.get("not-yet").await;
    w.fold.refresh();
    let mut told = vec![
        w.updates.try_recv().expect("one"),
        w.updates.try_recv().expect("two"),
    ];
    told.sort();
    let mut want = vec![id, "not-yet".to_owned()];
    want.sort();
    assert_eq!(told, want);

    w.e.close();
    w.fold.refresh();
    assert_eq!(w.updates.try_recv(), Err(TryRecvError::Empty));
}

/// fold-service.ts:208, :217 and :240-258: only a note the renderer opened regenerates, once
/// it rested for the idle window since its last change.
#[tokio::test(start_paused = true)]
async fn only_an_opened_note_regenerates_once_it_rests() {
    let mut w = world(
        &[
            ("a.md", &sectioned(3, "opened")),
            ("b.md", &sectioned(3, "unopened")),
        ],
        IDLE,
    );
    let (a, b) = (w.id_of("a.md"), w.id_of("b.md"));
    w.summarize(true);
    w.until_status(&a, FoldStatus::Ready).await;
    while w.updates.try_recv().is_ok() {}

    let step = Duration::from_millis(1);
    w.fold.note_changed(&b);
    w.fold.note_changed(&a);
    tokio::time::advance(IDLE - step).await;
    // A second change starts the window again: nothing fires when the first one ends.
    w.fold.note_changed(&a);
    assert!(
        tokio::time::timeout(IDLE / 2, w.updates.recv())
            .await
            .is_err(),
        "a note regenerated before it rested"
    );
    assert_eq!(w.next_update().await, a);
    assert!(
        tokio::time::timeout(IDLE * 2, w.updates.recv())
            .await
            .is_err(),
        "a note the renderer never opened regenerated"
    );
}

/// agent.ts `toFoldAgent` and fold-service.ts:94-100 over the local agent engine: the local
/// model writes every chunk, cached under `local_openai_compatible:<model>`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_local_model_writes_the_levels_through_the_agent_engine() {
    let fake = serve(|request| {
        if request.method == Method::GET && request.path.ends_with("/models") {
            return models(MODEL);
        }
        let prompt = request
            .messages()
            .iter()
            .filter_map(|m| m["content"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        answer(&valid_reply(&prompt).to_string(), false)
    })
    .await;
    let agents = Arc::new(FoldAgents::new(agent(provider(
        AgentLocalProviderPreset::Custom,
        &fake.base_url,
        MODEL,
    ))));
    let text = sectioned(3, "local");
    let mut w = world_on(&[("a.md", &text)], IDLE, Some(agents));
    let id = w.id_of("a.md");
    w.summarize(true);

    let ready = w.until_status(&id, FoldStatus::Ready).await;
    assert_eq!(ready.agent.as_deref(), Some("Local model"));
    assert_eq!(ready.sections[0].paragraphs[0].takeaway, "Takeaway 0.");
    let search = w.search();
    for mut key in chunk_keys(&text) {
        key.model_id = format!("local_openai_compatible:{MODEL}");
        assert!(search.fold_chunk(&key).expect("read").is_some());
    }
}
