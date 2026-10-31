//! The note index (Step 13e) follows the vault tier's facts, over a real session, tier and
//! watcher, and converges: an app write, a removal and lost facts keep the rows current; nothing
//! is worked before the open walk ends; a scan keeps the queued notes; a failed watcher still
//! owes the scan; a file that cannot be read is measured once it reads; and the search index
//! (links) is brought up to date at every open, not only after a pass that wrote rows.

mod device_key;
mod index_support;
mod vault_env;

use std::time::Instant;

use index_support::{all_indexed, note_text, path_of, seeded, until, with_task};
use memry_core::domain::note_stats::{MeasuredFile, measure};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::{IDLE_DELAY, NoteIndex};
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
        date: None,
        text: "stale".to_owned(),
    }
}

#[test]
fn facts_keep_the_rows_current_and_lost_facts_run_a_scan() {
    let (mut e, _store, notes) = seeded(3);
    let index = NoteIndex::new(e.tier.clone());
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
        date: None,
        text: "gone".into(),
    };
    open.search.index_note_files(vec![ghost]).unwrap();
    let (sender, receiver) = broadcast::channel(1);
    // Facts that ask for no scan themselves: only the lag can.
    for _ in 0..3 {
        let none = Applied::Removed {
            note_id: "no-such-note".into(),
            path: "none.md".into(),
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
    let index = NoteIndex::new(e.tier.clone());
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
