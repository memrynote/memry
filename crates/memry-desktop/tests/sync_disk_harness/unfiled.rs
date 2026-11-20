//! The first file of a note or day created on another device (#3534 L5b), over the harness of
//! `sync_disk_harness`.

use memry_desktop::notes::aliases::NoteAliasEditInput;
use memry_desktop::notes::service::NotesService;

use super::*;

/// A note A creates in `Work` reaches B as `Work/Remote plan.md` with A's body, a row with a
/// hash, and a place in the notes list. Red without the fix: the pass keeps `NoRow`, so no file.
#[tokio::test(flavor = "multi_thread")]
async fn a_note_created_on_a_gets_its_file_on_b() {
    let server = Server::start();
    let b = Disk::new(&server).await;
    b.sync().await;
    let a = Peer::new(&server).await;
    let id = a.create("Remote plan", Some("Work"), "from A");
    a.sync().await;

    for _ in 0..2 {
        b.sync().await;
    }
    until_holds(&b.env, "Work/Remote plan.md", "from A");
    filed(&b.env, &id, "Work/Remote plan.md");
    listed(&b.env, &id);
}

/// An outside file already at the note's name stays byte for byte; the note gets the next
/// numbered name, as Electron's `generateUniquePathSync` gives it.
#[tokio::test(flavor = "multi_thread")]
async fn an_outside_file_at_the_name_stays_and_the_note_is_numbered() {
    let server = Server::start();
    let b = Disk::new(&server).await;
    b.sync().await;
    let outside = "outside words\n";
    b.env.write("Work/Remote plan.md", outside);
    let a = Peer::new(&server).await;
    let id = a.create("Remote plan", Some("Work"), "from A");
    a.sync().await;

    for _ in 0..2 {
        b.sync().await;
    }
    until_holds(&b.env, "Work/Remote plan 1.md", "from A");
    filed(&b.env, &id, "Work/Remote plan 1.md");
    listed(&b.env, &id);
    assert_eq!(b.env.read("Work/Remote plan.md"), outside);
}

/// A journal day A writes reaches B's day file, at the path B's config gives the day.
#[tokio::test(flavor = "multi_thread")]
async fn a_journal_day_created_on_a_gets_its_day_file_on_b() {
    let server = Server::start();
    let b = Disk::new(&server).await;
    b.sync().await;
    let a = Peer::new(&server).await;
    let date = "2026-11-02";
    let typed = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: "day from A".into(),
        new_block_id: "a-day".into(),
    };
    let journal = a.core.journal(a.store.clone()).unwrap();
    journal.edit_day(date.into(), typed).unwrap();
    let id = journal.entry_id(date.into()).unwrap().expect("A's day");
    a.sync().await;

    for _ in 0..2 {
        b.sync().await;
    }
    let rel = "journal/2026-11-02.md";
    let file = until_holds(&b.env, rel, "day from A");
    assert!(
        file.contains("date: '2026-11-02'"),
        "the day's date: {file:?}"
    );
    filed(&b.env, &id, rel);
}

/// A note pulled by a driver that writes no file (a crash before the pass, a build before L5)
/// gets its file at the next open: the reconcile lists notes with no row.
#[tokio::test(flavor = "multi_thread")]
async fn a_note_with_no_file_at_open_gets_its_file() {
    let server = Server::start();
    let Disk {
        mut env,
        store,
        driver: observed,
        ..
    } = Disk::new(&server).await;
    // Its disk observer holds the vault, which a reopen waits out.
    drop(observed);
    let plain = driver(&env.core(), &auth(&server, 1, &store), Vec::new()).await;
    pass(&plain).await;
    let a = Peer::new(&server).await;
    let id = a.create("Remote plan", Some("Work"), "from A");
    a.sync().await;

    for _ in 0..2 {
        pass(&plain).await;
    }
    assert!(
        env.core().note_files().by_id(&id).unwrap().is_none(),
        "no file without the observer"
    );
    drop(plain);

    env.close();
    env.open();
    // The reconcile runs on the consumer's thread once the open walk is indexed.
    env.facts_until(indexed);
    until_holds(&env, "Work/Remote plan.md", "from A");
    filed(&env, &id, "Work/Remote plan.md");
    listed(&env, &id);
}

/// The other names A gives a note reach B's first file, so an alias B adds keeps them: the edit
/// reads the file's list into the record, and the record syncs. Red without the names in the
/// first file: B's record and A's become `[Q3]`.
#[tokio::test(flavor = "multi_thread")]
async fn a_pulled_notes_aliases_reach_its_file_and_survive_an_edit_on_b() {
    let server = Server::start();
    let b = Disk::new(&server).await;
    b.sync().await;
    let a = Peer::new(&server).await;
    let id = a.create("Plan", None, "from A");
    let writer = a.core.notes_writer(a.store.clone()).unwrap();
    let names = vec!["PM".to_owned(), "Roadmap".to_owned()];
    writer.set_aliases(id.clone(), names).unwrap();
    a.sync().await;

    for _ in 0..2 {
        b.sync().await;
    }
    let file = until_holds(&b.env, "Plan.md", "from A");
    assert!(file.contains("aliases:\n  - PM\n  - Roadmap\n"), "{file:?}");
    filed(&b.env, &id, "Plan.md");

    let open = b.env.session.current().unwrap();
    let notes = NotesService::new(b.env.tier.clone(), b.store.clone());
    let edit = NoteAliasEditInput {
        id: id.clone(),
        add: vec!["Q3".into()],
        remove: Vec::new(),
    };
    let all = ["PM", "Roadmap", "Q3"];
    assert_eq!(notes.edit_aliases(&open, &edit).unwrap().aliases, all);
    let aliases = |core: &Vault| core.notes().metadata(id.clone()).unwrap().unwrap().aliases;
    assert_eq!(aliases(&b.env.core()), all);
    b.sync().await;
    a.sync().await;
    assert_eq!(aliases(&a.core), all);
}
