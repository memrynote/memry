//! A pulled rename, move, tag or property change of a note B has a file for (#3534, Q5),
//! over the harness of `sync_disk_harness`, observed at the vault tier's row facts: the one
//! input of the shell's note events (`memry_tauri::shell::note_events`), which sends a
//! `Renamed` fact as `notes:renamed`, a `Moved` one as `notes:moved` and an outside `Changed`
//! one as `notes:updated`. Electron's `note-handler.ts` `applyUpsert` moves the file and sends
//! `notes:renamed` / `notes:moved`, and rewrites the frontmatter and sends `notes:updated`.

use memry_desktop::vault::consumer::{ChangeSource, MoveKind};

use super::*;

/// B's note reaches A, which then changes it with `change` and pushes.
async fn changed_on_a(server: &Server, b: &Disk, change: impl FnOnce(&Peer)) -> Peer {
    for _ in 0..2 {
        b.sync().await;
    }
    let a = Peer::new(server).await;
    for _ in 0..2 {
        a.sync().await;
    }
    change(&a);
    a.sync().await;
    for _ in 0..2 {
        b.sync().await;
    }
    a
}

/// A fact the note events send as an outside `notes:updated` for `note`.
fn updated(fact: &Applied, note: &str) -> bool {
    matches!(
        fact,
        Applied::Changed { note_id, source, .. }
            if note_id == note && !matches!(source, ChangeSource::App | ChangeSource::Walk)
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pulled_rename_moves_the_file_and_sends_renamed() {
    let server = Server::start();
    let mut b = Disk::new(&server).await;
    let note = b.note.clone();
    let _a = changed_on_a(&server, &b, |a| {
        let writer = a.core.notes_writer(a.store.clone()).unwrap();
        writer.rename(note.clone(), "Renamed".into()).unwrap();
    })
    .await;

    b.env.facts_until(|fact| {
        matches!(
            fact,
            Applied::Renamed { note_id, old_path, new_path, kind: MoveKind::Renamed }
                if *note_id == note && old_path == FILE && new_path == "Renamed.md"
        )
    });
    until_holds(&b.env, "Renamed.md", "first words");
    assert!(!b.path().exists(), "the old file is gone");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pulled_move_moves_the_file_and_sends_moved() {
    let server = Server::start();
    let mut b = Disk::new(&server).await;
    let note = b.note.clone();
    let _a = changed_on_a(&server, &b, |a| {
        let writer = a.core.notes_writer(a.store.clone()).unwrap();
        writer
            .move_to_folder(note.clone(), Some("Work".into()))
            .unwrap();
    })
    .await;

    b.env.facts_until(|fact| {
        matches!(
            fact,
            Applied::Renamed { note_id, old_path, new_path, kind: MoveKind::Moved }
                if *note_id == note && old_path == FILE && new_path == "Work/n.md"
        )
    });
    until_holds(&b.env, "Work/n.md", "first words");
}

#[tokio::test(flavor = "multi_thread")]
async fn pulled_tags_reach_the_file_and_send_updated() {
    let server = Server::start();
    let mut b = Disk::new(&server).await;
    let note = b.note.clone();
    let _a = changed_on_a(&server, &b, |a| {
        let writer = a.core.notes_writer(a.store.clone()).unwrap();
        writer
            .set_tags(note.clone(), vec!["remote".into()])
            .unwrap();
    })
    .await;

    b.env.facts_until(|fact| updated(fact, &note));
    let file = until_holds(&b.env, FILE, "remote");
    assert!(file.contains("tags:"), "{file:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pulled_property_reaches_the_file_and_sends_updated() {
    let server = Server::start();
    let mut b = Disk::new(&server).await;
    let note = b.note.clone();
    let _a = changed_on_a(&server, &b, |a| {
        let writer = a.core.notes_writer(a.store.clone()).unwrap();
        writer
            .set_property(note.clone(), "status".into(), "\"done\"".into())
            .unwrap();
    })
    .await;

    b.env.facts_until(|fact| updated(fact, &note));
    until_holds(&b.env, FILE, "status: done");
}

/// The moved, retagged file is the app's own write: B's watcher, consumer and index read it
/// without taking the old title or tags back into the record, so the next syncs leave A with
/// the pulled ones. Red when B's read of `Renamed.md` (or of the gone `n.md`) pushes `n` or no
/// tags.
#[tokio::test(flavor = "multi_thread")]
async fn a_pulled_rename_and_tags_are_not_pushed_back() {
    let server = Server::start();
    let mut b = Disk::new(&server).await;
    let note = b.note.clone();
    let a = changed_on_a(&server, &b, |a| {
        let writer = a.core.notes_writer(a.store.clone()).unwrap();
        writer.rename(note.clone(), "Renamed".into()).unwrap();
        writer
            .set_tags(note.clone(), vec!["remote".into()])
            .unwrap();
    })
    .await;

    until_holds(&b.env, "Renamed.md", "remote");
    // Everything the watcher saw of the move and the write is read before the probe.
    b.env.watcher_live();
    for _ in 0..2 {
        b.sync().await;
    }
    for _ in 0..2 {
        a.sync().await;
    }
    for core in [&a.core, &*b.env.core()] {
        let record = core
            .note_files()
            .placed(&note)
            .unwrap()
            .expect("a live note");
        assert_eq!(record.title, "Renamed");
        assert_eq!(record.tags, ["remote"]);
    }
    assert!(!b.path().exists(), "the old file is not made again");
    filed(&b.env, &note, "Renamed.md");
}
