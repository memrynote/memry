//! The note index (Step 13e) follows the vault tier's facts, over a real session, tier and
//! watcher, and converges: an app write, a removal and lost facts keep the rows current; nothing
//! is worked before the open walk ends, a watcher failure inside it and a reindex included; a
//! scan keeps the queued notes; a failed watcher still owes the scan; a file that cannot be read
//! is measured once it reads, and its backoff does not hold back an edit; a day file moved to
//! another day's path while the app was closed loses its stored day, though no fact said so;
//! and the search index (links) is brought up to date at every open, not only after a pass that
//! wrote rows. The open's build ends as walked only with a pass after the walk's `Indexed`, and
//! after the reindex that took it.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use index_support::{
    all_indexed, note_text, path_of, seeded, until, with_reporting_task, with_task, with_task_under,
};
use memry_core::domain::note_stats::{MeasuredFile, measure};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::{IDLE_DELAY, IndexProgress, NoteIndex, OpenBuild, TaskHandle};
use memry_desktop::session::OpenVault;
use memry_desktop::vault::consumer::rows::RowStat;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::file_types::FileType;
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::watch::VaultEvent;
use tokio::sync::broadcast;
use vault_env::{env, indexed};

/// A row measured from other text than the file's, though it names the file's bytes: only a
/// pass given the note re-measures it, a scan alone does not list it.
fn stale_row(id: &str, text: &str) -> MeasuredFile {
    MeasuredFile {
        note_id: id.to_owned(),
        file_hash: content_hash(text),
        text: "stale".to_owned(),
        properties: Vec::new(),
    }
}

/// The watcher's first pass ended: the walk starts.
fn rescanned() -> Applied {
    Applied::Vault(VaultEvent::Rescanned {
        missing: 0,
        removed: 0,
        added: 0,
        changed: 0,
        removals_withheld: false,
    })
}

type Reported = Arc<Mutex<Vec<IndexProgress>>>;

fn reporter(reported: &Reported) -> impl Fn(IndexProgress) + Sync + use<> {
    let reported = reported.clone();
    move |step| reported.lock().unwrap().push(step)
}

#[test]
fn facts_keep_the_rows_current_and_lost_facts_run_a_scan() {
    let (mut e, _store, notes) = seeded(3);
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    e.drain();
    e.open();
    e.facts_until(indexed);
    until("the seeded notes measured", || all_indexed(&e));
    let open = e.session.current().unwrap();
    let rows = e.tier.rows();
    let session = rows.session_for(&open.vault).unwrap();

    // An app write: the new text is measured once the queue is due. The end of the walk
    // asked for a scan, which may measure the first write; it is done once the first write
    // is measured, so only the write's own fact can measure the second.
    let (id, path) = &notes[0];
    for text in [
        "---\ntags: [fresh]\n---\nfour words right here\n",
        "then five other words here\n- [ ] and a task {task:t9}\n",
    ] {
        // Told to the own-write record first, as the app does: the watcher reports nothing.
        e.tier.echo().will_write(path, &content_hash(text));
        e.write(path, text);
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: text.len() as u64,
            content_hash: Some(content_hash(text)),
            file_hash: Some(content_hash(text)),
        };
        rows.record_write(session, id, path, stat).unwrap();
        until("the write measured", || {
            open.search.note_stats(id).unwrap().unwrap().stats == measure(text)
        });
    }

    // A removal drops the row.
    let (gone, _) = &notes[1];
    assert!(rows.remove(session, gone).unwrap());
    until("the removed note's row dropped", || {
        open.search.note_stats(gone).unwrap().is_none()
    });

    // Facts lost to a lagged subscription: a scan measures what has no row and drops the row
    // of a note no fact said was gone.
    let (lost, _) = &notes[2];
    assert!(open.search.forget_note_stats(lost).unwrap());
    let ghost = MeasuredFile {
        note_id: "ghost".into(),
        file_hash: "h".into(),
        text: "gone".into(),
        properties: Vec::new(),
    };
    open.search.index_note_files(vec![ghost]).unwrap();
    let (sender, receiver) = broadcast::channel(1);
    // Facts that ask for no scan themselves: only the lag can.
    for _ in 0..3 {
        let none = Applied::Removed {
            note_id: "no-such-note".into(),
            path: "none.md".into(),
            source: ChangeSource::Watcher,
        };
        sender.send(none).unwrap();
    }
    with_task(&open, receiver, |_| {
        until("the lost note measured and the ghost dropped", || {
            open.search.note_stats(lost).unwrap().is_some()
                && open.search.note_stats("ghost").unwrap().is_none()
        });
    });
    e.close();
}

/// A queued note waits for the end of the open walk, and the walk's scan, which does not list
/// it (its row names the file's bytes), keeps it.
#[test]
fn nothing_is_measured_before_the_walk_ends_and_its_scan_keeps_the_queue() {
    let (mut e, _store, notes) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    let ((queued, path), (other, _)) = (&notes[0], &notes[1]);
    let text = note_text(0);
    open.search
        .index_note_files(vec![stale_row(queued, &text)])
        .unwrap();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |_| {
        sender
            .send(Applied::Changed {
                note_id: queued.clone(),
                path: path.clone(),
                content_hash: Some(content_hash(&text)),
                source: ChangeSource::Watcher,
            })
            .unwrap();
        // Twice the queue's delay, then nothing measured yet: the walk has not ended.
        std::thread::sleep(IDLE_DELAY * 2);
        let row = open.search.note_stats(queued).unwrap().unwrap();
        assert_eq!(row.stats.snippet, "stale");
        assert!(open.search.note_stats(other).unwrap().is_none());

        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("the queued note and the unmeasured one measured", || {
            open.search.note_stats(queued).unwrap().unwrap().stats == measure(&text)
                && open.search.note_stats(other).unwrap().is_some()
        });
    });
    e.close();
}

/// No `Indexed` follows a watcher that did not start; its failure owes the scan instead.
#[test]
fn a_failed_watcher_still_owes_the_scan() {
    let (mut e, _store, notes) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |_| {
        let failed = VaultEvent::WatchFailed {
            message: "no watcher".into(),
            limit: false,
        };
        sender.send(Applied::Vault(failed)).unwrap();
        until("both notes measured", || {
            notes
                .iter()
                .all(|(id, _)| open.search.note_stats(id).unwrap().is_some())
        });
    });
    e.close();
}

/// A file that cannot be read leaves its note owed: it is measured once it reads, though
/// nothing changes it.
#[cfg(unix)]
#[test]
fn a_file_that_could_not_be_read_is_measured_once_it_reads() {
    use std::os::unix::fs::PermissionsExt as _;

    let (mut e, _store, notes) = seeded(1);
    e.open();
    let open = e.session.current().unwrap();
    let (id, path) = &notes[0];
    let file = e.vault.join(path);
    let mode = |bits| std::fs::set_permissions(&file, std::fs::Permissions::from_mode(bits));
    mode(0o000).unwrap();
    if std::fs::read(&file).is_ok() {
        // Run as root: no permission keeps the file from being read.
        mode(0o644).unwrap();
        e.close();
        return;
    }
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |_| {
        sender.send(Applied::Indexed { complete: true }).unwrap();
        // The scan's pass ran and could not read it.
        std::thread::sleep(IDLE_DELAY * 2);
        assert!(open.search.note_stats(id).unwrap().is_none());
        mode(0o644).unwrap();
        until("the file measured once it reads", || {
            open.search.note_stats(id).unwrap().is_some()
        });
    });
    e.close();
}

/// A vault the app has never seen: the open walk gives every file its note through the notes
/// identity (tier 0), the index measures each once (tier 1), and the search index holds the
/// notes' links. At the next open the links are rebuilt though no row is measured: an index
/// whose last search reindex never committed is not left so until an edit.
#[test]
fn a_fresh_vault_gets_its_notes_then_their_stats_and_links_at_every_open() {
    const FRESH: usize = 300;
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    for i in 0..FRESH {
        e.write(&path_of(i), &note_text(i));
    }
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    let started = Instant::now();
    e.open();
    e.facts_until(indexed);
    let tier0 = started.elapsed();
    until("every note measured", || all_indexed(&e));
    println!(
        "fresh {FRESH} notes: tier 0 {tier0:?}, tier 1 {:?}",
        started.elapsed()
    );
    let rows = e.rows();
    assert_eq!(rows.len(), FRESH);
    let search = e.session.current().unwrap().search;
    let id_of = |n: usize| -> String {
        let path = path_of(n);
        rows.iter().find(|(_, p)| *p == path).unwrap().0.clone()
    };
    for (id, path) in &rows {
        let n = (0..FRESH).find(|n| path_of(*n) == *path).unwrap();
        let stored = search.note_stats(id).unwrap().expect("a row");
        assert_eq!(stored.stats, measure(&note_text(n)), "{path}");
    }
    let (first, second) = (id_of(0), id_of(1));
    let links_to_second = |search: &memry_core::api::search::Search| {
        until("the first note links the second", || {
            search
                .links_from(first.clone())
                .unwrap()
                .iter()
                .any(|link| link.target_id.as_deref() == Some(second.as_str()))
        });
    };
    links_to_second(&search);
    // The search handle holds the vault: let go of it before the close.
    drop(search);
    e.close();

    // As a crash inside the search reindex leaves it: rows measured, links never committed.
    rusqlite::Connection::open(e.vault.join(".memry/core/index.db"))
        .unwrap()
        .execute_batch("DELETE FROM note_links; DELETE FROM index_meta;")
        .unwrap();
    e.open();
    let search = e.session.current().unwrap().search;
    links_to_second(&search);
    drop(search);
    e.close();
}

/// The walk runs from the watcher's first `Rescanned` to `Indexed`. A watcher failure inside it
/// does not end it, and a reindex asked meanwhile waits for its end too.
#[test]
fn a_walk_holds_the_work_and_a_reindex_through_a_watcher_failure() {
    let (mut e, _store, notes) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |handle| {
        sender.send(rescanned()).unwrap();
        let failed = VaultEvent::WatchFailed {
            message: "an OS watcher error".into(),
            limit: false,
        };
        sender.send(Applied::Vault(failed)).unwrap();
        let steps: Arc<Mutex<Vec<IndexProgress>>> = Arc::default();
        let seen = steps.clone();
        let answer = handle
            .reindex(Box::new(move |step| seen.lock().unwrap().push(step)))
            .unwrap();
        // Twice the queue's delay, then nothing measured and no progress: the walk runs.
        std::thread::sleep(IDLE_DELAY * 2);
        for (id, _) in &notes {
            assert!(open.search.note_stats(id).unwrap().is_none(), "{id}");
        }
        assert!(steps.lock().unwrap().is_empty());

        sender.send(Applied::Indexed { complete: true }).unwrap();
        let done = answer.recv().unwrap().unwrap();
        assert_eq!(done.indexed, notes.len());
        // Less than a batch: the step after the last write is the total.
        let step = |built| IndexProgress { built, total: 2 };
        assert_eq!(*steps.lock().unwrap(), [step(0), step(2)]);
    });
    e.close();
}

/// A file that never reads backs its retries off: after these reindexes, past any wait here.
/// An edit of another note is measured all the same, at its fact's own delay.
#[cfg(unix)]
#[test]
fn an_edit_beside_a_file_that_never_reads_is_not_held_by_its_backoff() {
    use std::os::unix::fs::PermissionsExt as _;

    let (mut e, _store, notes) = seeded(2);
    let ((stuck, stuck_path), (id, path)) = (&notes[0], &notes[1]);
    let file = e.vault.join(stuck_path);
    let mode = |bits| std::fs::set_permissions(&file, std::fs::Permissions::from_mode(bits));
    mode(0o000).unwrap();
    if std::fs::read(&file).is_ok() {
        // Run as root: no permission keeps the file from being read.
        mode(0o644).unwrap();
        return;
    }
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    e.drain();
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().unwrap();
    until("the readable note measured", || {
        open.search.note_stats(id).unwrap().is_some()
    });
    // Each pass that cannot read the file doubles the backoff: 2^7 s and more after these.
    for _ in 0..7 {
        assert_eq!(index.reindex(|_| {}).unwrap().unread, 1);
    }

    let text = "an edit of the other note\n";
    e.tier.echo().will_write(path, &content_hash(text));
    e.write(path, text);
    let rows = e.tier.rows();
    let session = rows.session_for(&open.vault).unwrap();
    let stat = RowStat {
        file_type: FileType::Markdown,
        size: text.len() as u64,
        content_hash: Some(content_hash(text)),
        file_hash: Some(content_hash(text)),
    };
    rows.record_write(session, id, path, stat).unwrap();
    until("the edit measured", || {
        open.search.note_stats(id).unwrap().unwrap().stats == measure(text)
    });
    assert!(open.search.note_stats(stuck).unwrap().is_none());
    mode(0o644).unwrap();
    e.close();
}

/// A day's row takes the day its record says. Its file moved to another day's path while the
/// app was closed is that day now (`renameKeepsJournalDate`): the open's scan drops the old
/// day's row and measures the new day's with its date.
#[test]
fn a_day_moved_to_another_days_path_is_that_day_in_the_index() {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write("journal/2026-01-05.md", "A day\n");
    e.open();
    e.facts_until(indexed);
    let day = |open: &memry_desktop::session::OpenVault, id: &str| {
        open.search.note_stats(id).unwrap().map(|row| row.date)
    };
    let open = e.session.current().unwrap();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |_| {
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("the day's row", || {
            day(&open, "j2026-01-05") == Some(Some("2026-01-05".to_owned()))
        });
    });
    drop(open);
    e.close();

    std::fs::rename(
        e.vault.join("journal/2026-01-05.md"),
        e.vault.join("journal/2026-01-06.md"),
    )
    .unwrap();
    e.open();
    until("the open made the new day", || {
        e.rows()
            .iter()
            .any(|(row, at)| row == "j2026-01-06" && at == "journal/2026-01-06.md")
    });
    let open = e.session.current().unwrap();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |_| {
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("the new day's row, and none of the old", || {
            day(&open, "j2026-01-06") == Some(Some("2026-01-06".to_owned()))
                && day(&open, "j2026-01-05").is_none()
        });
    });
    drop(open);
    e.close();
}

/// A reindex asked during the walk runs at its end and takes the open's pass: its own callback
/// refreshes the list, so no later pass reports the open's progress.
#[test]
fn a_reindex_at_the_walks_end_takes_the_opens_report() {
    let (mut e, _store, notes) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    let reported = Reported::default();
    let (sender, receiver) = broadcast::channel(16);
    with_reporting_task(&open, receiver, &reporter(&reported), |handle| {
        sender.send(rescanned()).unwrap();
        let answer = handle.reindex(Box::new(|_| {})).unwrap();
        sender.send(Applied::Indexed { complete: true }).unwrap();
        assert_eq!(answer.recv().unwrap().unwrap().indexed, notes.len());

        // A live pass after it.
        let ((id, path), text) = (&notes[0], note_text(0));
        open.search
            .index_note_files(vec![stale_row(id, &text)])
            .unwrap();
        sender
            .send(Applied::Changed {
                note_id: id.clone(),
                path: path.clone(),
                content_hash: Some(content_hash(&text)),
                source: ChangeSource::Watcher,
            })
            .unwrap();
        until("the live pass measured", || {
            open.search.note_stats(id).unwrap().unwrap().stats == measure(&text)
        });
    });
    assert_eq!(*reported.lock().unwrap(), []);
    e.close();
}

/// A watcher that failed before any walk takes the open's report with its pass. A walk that
/// comes after all the same reports again at its end: its pass is the one that fills the list.
#[test]
fn the_walks_end_reports_though_a_failed_watchers_pass_reported_first() {
    let (mut e, _store, _) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    let reported = Reported::default();
    let (sender, receiver) = broadcast::channel(16);
    let step = |built, total| IndexProgress { built, total };
    with_reporting_task(&open, receiver, &reporter(&reported), |_| {
        let failed = VaultEvent::WatchFailed {
            message: "no watcher".into(),
            limit: false,
        };
        sender.send(Applied::Vault(failed)).unwrap();
        until("the failed watcher's pass reported its total", || {
            reported.lock().unwrap().last() == Some(&step(2, 2))
        });
        reported.lock().unwrap().clear();

        sender.send(rescanned()).unwrap();
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("the walk's pass reported", || {
            !reported.lock().unwrap().is_empty()
        });
        // Nothing left to measure: `0` of `0`, which still refreshes the list.
        assert_eq!(*reported.lock().unwrap(), [step(0, 0)]);
    });
    e.close();
}

/// What the task told: the open's build, and a reindex's steps.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Told {
    Build(OpenBuild),
    Reindexed,
}

type Log = Arc<Mutex<Vec<Told>>>;

/// Runs a task whose facts start with `early`, sent before it reads any, into a channel of
/// `capacity`; the open's build goes to the log, its steps left out.
fn with_build_log(
    open: &OpenVault,
    capacity: usize,
    early: &[Applied],
    test: impl FnOnce(&TaskHandle, &broadcast::Sender<Applied>, &Log),
) {
    let (sender, receiver) = broadcast::channel(capacity);
    for fact in early {
        sender.send(fact.clone()).unwrap();
    }
    let log = Log::default();
    let told = log.clone();
    let report = move |build| {
        if !matches!(build, OpenBuild::Step(_)) {
            told.lock().unwrap().push(Told::Build(build));
        }
    };
    with_task_under(
        open,
        receiver,
        device_key::with_device_key(),
        &report,
        |handle| test(handle, &sender, &log),
    );
}

fn told(log: &Log) -> Vec<Told> {
    log.lock().unwrap().clone()
}

/// A pass before the walk's `Indexed` (lost facts, or a watcher that failed before its first
/// pass) ends the open's build, but not as walked: the rows may miss notes the walk has not
/// offered, so a job waiting on them (`NoteIndex::wait_built`) waits for the walk's pass. A lag
/// that lost `Indexed` leaves it waiting for the next open.
#[test]
fn a_pass_before_the_walks_indexed_ends_the_build_unwalked() {
    let (mut e, _store, _) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    let failed = Applied::Vault(VaultEvent::WatchFailed {
        message: "no watcher".into(),
        limit: false,
    });
    // A channel of one, sent three facts before the task reads: its first read is `Lagged`.
    let lost = (1, vec![rescanned(); 3]);
    for (capacity, early) in [lost, (16, vec![failed])] {
        with_build_log(&open, capacity, &early, |_, sender, log| {
            until("the early pass ended the build", || !told(log).is_empty());
            assert_eq!(told(log), [Told::Build(OpenBuild::Ended { walked: false })]);
            sender.send(rescanned()).unwrap();
            sender.send(Applied::Indexed { complete: true }).unwrap();
            until("the walk's pass ended the build", || told(log).len() == 3);
            assert_eq!(
                told(log)[1..],
                [
                    Told::Build(OpenBuild::Owed),
                    Told::Build(OpenBuild::Ended { walked: true }),
                ]
            );
        });
    }
    e.close();
}

/// A reindex asked during the walk takes the open's build: the build ends once the reindex
/// answered, so a job waiting on the rows (`NoteIndex::wait_built`) does not start beside it.
#[test]
fn the_open_build_ends_after_the_reindex_that_took_it() {
    let (mut e, _store, _) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    with_build_log(&open, 16, &[rescanned()], |handle, sender, log| {
        let reindexed = log.clone();
        let answer = handle
            .reindex(Box::new(move |_| {
                reindexed.lock().unwrap().push(Told::Reindexed);
            }))
            .unwrap();
        sender.send(Applied::Indexed { complete: true }).unwrap();
        answer.recv().unwrap().unwrap();
        until("the build ended", || {
            told(log).contains(&Told::Build(OpenBuild::Ended { walked: true }))
        });
        let told = told(log);
        assert_eq!(
            told.last(),
            Some(&Told::Build(OpenBuild::Ended { walked: true })),
            "{told:?}"
        );
        assert!(
            told[..told.len() - 1].iter().all(|t| *t == Told::Reindexed),
            "{told:?}"
        );
        assert!(told.len() > 1, "the reindex stepped: {told:?}");
    });
    e.close();
}

/// Whether the search index holds `from`'s link to `to`.
fn links_to(open: &OpenVault, from: &str, to: &str) -> bool {
    (open.search.links_from(from.to_owned()).unwrap().iter())
        .any(|link| link.target_id.as_deref() == Some(to))
}

/// A first sync holds the search reindex (#5409): the reindex holds the `data.db` writer for its
/// whole pass, which the first sync's bodies pass waits on. The rows are measured meanwhile, and
/// the reindex runs once the first sync ends.
#[test]
fn a_first_sync_holds_the_search_reindex_until_it_ends() {
    let (mut e, _store, notes) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    let (first, second) = (&notes[0].0, &notes[1].0);
    assert!(!links_to(&open, first, second), "no reindex ran yet");
    let hold = open.first_sync.hold();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |_| {
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("every note measured", || all_indexed(&e));
        std::thread::sleep(IDLE_DELAY * 2);
        assert!(!links_to(&open, first, second), "held by the first sync");
        drop(hold);
        until("the reindex ran", || links_to(&open, first, second));
    });
    drop(open);
    e.close();
}

/// A vault closed (a quit, a crash) while a first sync held its reindex owes it at the next
/// open, and the search ends up complete (#5409).
#[test]
fn a_reindex_a_first_sync_held_runs_at_the_next_open() {
    let (mut e, _store, notes) = seeded(2);
    let (first, second) = (&notes[0].0, &notes[1].0);
    e.open();
    let open = e.session.current().unwrap();
    let hold = open.first_sync.hold();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |_| {
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("every note measured", || all_indexed(&e));
        std::thread::sleep(IDLE_DELAY * 2);
        assert!(!links_to(&open, first, second), "held by the first sync");
    });
    drop((hold, open));
    e.close();

    e.open();
    let open = e.session.current().unwrap();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |_| {
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("the reindex ran", || links_to(&open, first, second));
    });
    drop(open);
    e.close();
}

/// A reindex asked while a first sync runs stays pending, not answered as done with its search
/// deferred, and is answered once the first sync ended (#5409).
#[test]
fn a_reindex_asked_during_a_first_sync_is_answered_once_it_ended() {
    let (mut e, _store, notes) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    let (first, second) = (&notes[0].0, &notes[1].0);
    let hold = open.first_sync.hold();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |task| {
        sender.send(Applied::Indexed { complete: true }).unwrap();
        let answer = task.reindex(Box::new(|_| {})).unwrap();
        std::thread::sleep(IDLE_DELAY * 2);
        assert!(
            answer.try_recv().is_err(),
            "pending while the first sync runs"
        );
        drop(hold);
        answer
            .recv_timeout(Duration::from_secs(30))
            .unwrap()
            .unwrap();
        assert!(
            links_to(&open, first, second),
            "the answer follows the reindex"
        );
    });
    drop(open);
    e.close();
}

/// A first sync that starts while an asked reindex runs holds its search reindex: the answer
/// waits for the first sync to end and the reindex to run after it, so it never says the search
/// is current while it was deferred (#5423 C88.1).
#[test]
fn a_reindex_a_first_sync_held_midway_is_answered_once_it_ended() {
    let (mut e, _store, notes) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    let (first, second) = (&notes[0].0, &notes[1].0);
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |task| {
        // Asked before the walk ends, the reindex is the first pass: no search reindex ran yet.
        // The first sync starts once the reindex is under way, before its search reindex.
        let hold = Arc::new(Mutex::new(None));
        let (running, taken) = (open.first_sync.clone(), hold.clone());
        let mut started = false;
        let answer = task
            .reindex(Box::new(move |_| {
                if !std::mem::replace(&mut started, true) {
                    *taken.lock().unwrap() = Some(running.hold());
                }
            }))
            .unwrap();
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("the first sync started", || hold.lock().unwrap().is_some());
        std::thread::sleep(IDLE_DELAY * 2);
        assert!(
            answer.try_recv().is_err(),
            "pending while the first sync holds its search reindex"
        );
        assert!(!links_to(&open, first, second), "held by the first sync");
        drop(hold.lock().unwrap().take());
        answer
            .recv_timeout(Duration::from_secs(30))
            .unwrap()
            .unwrap();
        assert!(
            links_to(&open, first, second),
            "the answer follows the reindex"
        );
    });
    drop(open);
    e.close();
}

/// Two reindexes asked at once while the first one's pass meets a first sync: the second runs
/// no pass while the first sync holds, and both are answered once it ended (#5423 C8).
#[test]
fn a_held_reindex_holds_the_reindexes_asked_after_it() {
    let (mut e, _store, notes) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    let (first, second) = (&notes[0].0, &notes[1].0);
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |task| {
        let hold = Arc::new(Mutex::new(None));
        let (running, taken) = (open.first_sync.clone(), hold.clone());
        let mut started = false;
        let held = task
            .reindex(Box::new(move |_| {
                if !std::mem::replace(&mut started, true) {
                    *taken.lock().unwrap() = Some(running.hold());
                }
            }))
            .unwrap();
        let reported = Reported::default();
        let after = task.reindex(Box::new(reporter(&reported))).unwrap();
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("the first sync started", || hold.lock().unwrap().is_some());
        std::thread::sleep(IDLE_DELAY * 2);
        assert!(held.try_recv().is_err() && after.try_recv().is_err());
        assert!(
            reported.lock().unwrap().is_empty(),
            "no pass for the second asker while the first sync holds"
        );
        drop(hold.lock().unwrap().take());
        for answer in [held, after] {
            answer
                .recv_timeout(Duration::from_secs(30))
                .unwrap()
                .unwrap();
        }
        assert!(!reported.lock().unwrap().is_empty());
        assert!(links_to(&open, first, second));
    });
    drop(open);
    e.close();
}

/// A reindex a first sync held and ran again after it reports one progress that never goes
/// back: the rerun does not restart its steps from 0 (#5423 C9b).
#[test]
fn a_held_reindex_reports_progress_that_never_goes_back() {
    let (mut e, _store, _notes) = seeded(2);
    e.open();
    let open = e.session.current().unwrap();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |task| {
        let hold = Arc::new(Mutex::new(None));
        let reported = Reported::default();
        let (running, taken, seen) = (open.first_sync.clone(), hold.clone(), reported.clone());
        let answer = task
            .reindex(Box::new(move |step| {
                let mut seen = seen.lock().unwrap();
                if seen.is_empty() {
                    *taken.lock().unwrap() = Some(running.hold());
                }
                seen.push(step);
            }))
            .unwrap();
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("the first sync started", || hold.lock().unwrap().is_some());
        std::thread::sleep(IDLE_DELAY * 2);
        assert!(answer.try_recv().is_err(), "held");
        drop(hold.lock().unwrap().take());
        answer
            .recv_timeout(Duration::from_secs(30))
            .unwrap()
            .unwrap();
        let steps = reported.lock().unwrap().clone();
        assert!(
            steps.windows(2).all(|pair| pair[0].built <= pair[1].built),
            "progress went back: {steps:?}"
        );
        assert_eq!(steps.last().map(|step| step.built), Some(2));
    });
    drop(open);
    e.close();
}
