//! An exclude pattern change in Settings (Step 13m-7b-3, #3530), on an open vault whose notes
//! the app's own identity (`NotesIdentity`) names. Electron's `updateConfig` restarts its
//! watcher on the new patterns and rebuilds its derived index; it deletes no note record and
//! syncs no delete, and a file that stops matching comes back under its record's id. Here the
//! watcher and the consumer restart on the saved patterns, and every row stays.
//!
//! | Test                                                            | Rule                                    |
//! | --------------------------------------------------------------- | --------------------------------------- |
//! | excluding a folder keeps its notes, and including it takes ...  | no record deleted, same id, no duplicate |
//! | an excluded note's body change from elsewhere reaches its file  | its row and write-back stay             |
//! | excluding the journal folder keeps every day                    | a day is a day by folder and format     |
//! | an exclude change killed at any step keeps every note           | the save is the only durable step       |
//! | an excluded note renamed outside keeps its record               | `note_metadata`: no delete syncs        |
//! | an excluded note deleted outside keeps its record through a ... | the same, an overflow resync included   |
//! | an excluded folder renamed outside keeps the record it left     | the same; the file is a new note        |
//! | a restart during the open walk still writes back what it owed   | the restart's walk reconciles too       |
//! | an excluded note moved out while closed keeps its id            | a covered gone home still pairs         |
//! | an excluded note moved out unseen keeps its id                  | the same, in a restart's rescan         |
//! | an excluded note moved out live is a new note                   | the watcher never saw it go             |
//! | an excluded day moved out to a note keeps its record            | a covered record never crosses          |
//! | an excluded note moved out to a day keeps its record            | the same, the other way                 |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::error::CoreError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::VaultConfigPatch;
use memry_desktop::vault::config::config_path;
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::consumer::identity::NoteIdentity;
use memry_desktop::vault::watch::VaultEvent;
use serde_json::json;
use vault_env::{Env, QUIET, WAIT, creates, env, indexed};

use crate::journal_change_crash::{change_killed, reopened};
use crate::journal_folder::{DAY, crossed, daily, outbox, quiet, reopen, row, try_day};
use crate::vault_settings::{opened_keeping, stored, update};

const DEFAULTS: [&str; 5] = [".git", "node_modules", ".trash", ".obsidian", ".memry"];

fn excludes(extra: &[&str]) -> VaultConfigPatch {
    VaultConfigPatch {
        exclude_patterns: Some(
            DEFAULTS
                .iter()
                .chain(extra)
                .map(|p| (*p).to_owned())
                .collect(),
        ),
        ..VaultConfigPatch::default()
    }
}

/// A vault with a note in `archive/` and one in `notes/`, and their ids.
fn two_notes() -> (Env, Arc<dyn SecureStore>, String, String) {
    let (e, store) = opened_keeping(
        json!({"excludePatterns": DEFAULTS}),
        &[("archive/old.md", "Old\n"), ("notes/new.md", "New\n")],
    );
    let id = |path: &str| {
        e.rows()
            .into_iter()
            .find(|(_, at)| at == path)
            .unwrap_or_else(|| panic!("{path}: {:?}", e.rows()))
            .0
    };
    let (old, new) = (id("archive/old.md"), id("notes/new.md"));
    (e, store, old, new)
}

/// The update's tier restart ends with a walk: its facts up to that walk's end.
fn changed(e: &mut Env, patch: VaultConfigPatch) -> Vec<Applied> {
    let mut heard = None;
    let settings = update(e, patch, |settings| heard = Some(settings.clone())).unwrap();
    assert_eq!(heard.as_ref(), Some(&settings));
    e.facts_until(indexed)
}

/// Every record of `ids` is at its path, no other row came, and none queued a delete.
fn kept(e: &Env, rows: &[(String, String)]) {
    assert_eq!(e.rows(), rows);
    for (id, _) in rows {
        assert!(!outbox(e, id).contains(&"delete".to_owned()), "{id}");
    }
}

/// Excluding `archive` keeps its note's row, and the watcher no longer reads the folder: an
/// outside edit there reaches nothing. Three opens keep the row. Dropping the pattern again
/// takes the file back under the same id, the edit made meanwhile with it, with no new note.
#[test]
fn excluding_a_folder_keeps_its_notes_and_including_it_takes_them_back() {
    let (mut e, _store, old, _new) = two_notes();
    let rows = e.rows();

    let facts = changed(&mut e, excludes(&["archive"]));
    assert!(!crossed(&facts), "{facts:?}");
    assert_eq!(stored(&e.vault)["excludePatterns"][5], "archive");
    kept(&e, &rows);

    e.write("archive/old.md", "Edited while excluded\n");
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(
        facts.is_empty(),
        "the old watcher still reads it: {facts:?}"
    );
    assert_eq!(e.body(&old), "Old");

    for _ in 0..3 {
        reopen(&mut e);
    }
    kept(&e, &rows);
    assert_eq!(e.body(&old), "Old");

    let facts = changed(&mut e, excludes(&[]));
    assert!(!crossed(&facts), "{facts:?}");
    assert!(
        facts
            .iter()
            .any(|f| matches!(f, Applied::Changed { note_id, .. } if *note_id == old)),
        "{facts:?}"
    );
    assert_eq!(e.body(&old), "Edited while excluded");
    kept(&e, &rows);
    reopen(&mut e);
    kept(&e, &rows);
}

/// Live edits under a folder whose pattern was dropped reach their note without a reopen.
#[test]
fn a_folder_no_longer_excluded_is_watched_at_once() {
    let (mut e, _store) = opened_keeping(
        json!({"excludePatterns": ["archive"]}),
        &[("notes/new.md", "New\n")],
    );
    e.write("archive/old.md", "Old\n");
    std::thread::sleep(QUIET);
    assert!(e.drain().is_empty());
    let rows = e.rows();

    let facts = changed(&mut e, excludes(&[]));
    let added: Vec<_> = facts
        .iter()
        .filter_map(|f| match f {
            Applied::Added { note_id, path, .. } => Some((note_id.clone(), path.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(added.len(), 1, "{facts:?}");
    assert_eq!(added[0].1, "archive/old.md");
    let id = added[0].0.clone();

    e.write("archive/old.md", "Edited\n");
    let deadline = std::time::Instant::now() + WAIT;
    while e.body(&id) != "Edited" {
        assert!(
            std::time::Instant::now() < deadline,
            "the edit never landed"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!(e.rows().len(), rows.len() + 1);
}

/// The row of an excluded note stays, so a body change that reaches its document from
/// elsewhere (another device's, through sync) is still written to its file, as the write-back
/// carries a locked note's. The app's own writes are refused (`vault_exclude_read_only`).
#[test]
fn an_excluded_notes_body_change_from_elsewhere_still_reaches_its_file() {
    let (mut e, store, old, _new) = two_notes();
    changed(&mut e, excludes(&["archive"]));
    e.edit_in_app(&store, &old, "Edited in the app");
    e.tier.schedule(&old);
    assert!(e.tier.flush(WAIT));
    assert!(e.read("archive/old.md").contains("Edited in the app"));
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(!crossed(&facts), "{facts:?}");
    assert!(!outbox(&e, &old).contains(&"delete".to_owned()));
}

/// The days of an excluded journal folder stay days: a day is one by its folder and format,
/// which the patterns do not change, through three opens. No day is made there meanwhile: the
/// folder is read-only (`vault_exclude_read_only`).
#[test]
fn excluding_the_journal_folder_keeps_every_day() {
    let (mut e, store) = opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let notes = NotesService::new(e.tier.clone(), store);
    let facts = changed(&mut e, excludes(&["journal"]));
    assert!(!crossed(&facts), "{facts:?}");
    let refused = try_day(&notes, &e, "2025-01-06").unwrap_err();
    assert_eq!(refused.kind_and_code().1, "note_excluded");
    for _ in 0..3 {
        reopen(&mut e);
    }
    let rows = e.rows();
    assert!(
        rows.contains(&row(DAY, "journal/2025-01-02.md")),
        "{rows:?}"
    );
    assert!(!e.vault.join("journal/2025-01-06.md").exists());
    for (id, _) in &rows {
        assert!(!outbox(&e, id).contains(&"delete".to_owned()), "{id}");
    }
    changed(&mut e, excludes(&[]));
    assert_eq!(e.rows(), rows);
}

/// Killed at each step of the change, as a crash stops it: the next three opens keep every row
/// and its id, read the saved patterns, and the pattern dropped again takes no note twice.
#[test]
fn an_exclude_change_killed_at_any_step_keeps_every_note() {
    let (e, ..) = two_notes();
    let (steps, killed) = change_killed(&e, excludes(&["archive"]), None);
    assert!(!killed);
    assert!(steps >= 2, "saved, then the watcher stopped: {steps}");
    drop(e);
    for kill_at in 1..=steps {
        let (mut e, ..) = two_notes();
        let rows = e.rows();
        let (_, killed) = change_killed(&e, excludes(&["archive"]), Some(kill_at));
        assert!(killed, "step {kill_at}");
        reopened(&mut e);
        for _ in 0..3 {
            reopen(&mut e);
        }
        assert_eq!(stored(&e.vault)["excludePatterns"][5], "archive");
        kept(&e, &rows);
        let facts = changed(&mut e, excludes(&[]));
        assert!(!crossed(&facts), "step {kill_at}: {facts:?}");
        kept(&e, &rows);
    }
}

/// No fact removed `id`.
fn not_removed(facts: &[Applied], id: &str) {
    assert!(
        !facts
            .iter()
            .any(|f| matches!(f, Applied::Removed { note_id, .. } if note_id == id)),
        "{facts:?}"
    );
}

/// Renamed outside the app inside the excluded folder: the watcher does not read there, so the
/// record keeps its path and nothing is removed, through three opens.
#[test]
fn an_excluded_note_renamed_outside_keeps_its_record() {
    let (mut e, _store, old, _new) = two_notes();
    let rows = e.rows();
    changed(&mut e, excludes(&["archive"]));
    fs::rename(
        e.vault.join("archive/old.md"),
        e.vault.join("archive/old2.md"),
    )
    .unwrap();
    quiet(&mut e);
    for _ in 0..3 {
        reopen(&mut e);
    }
    kept(&e, &rows);

    // Read again once the pattern is dropped, the rename pairs as the note's move.
    let facts = changed(&mut e, excludes(&[]));
    assert!(
        facts
            .iter()
            .any(|f| matches!(f, Applied::Renamed { note_id, new_path, .. }
            if *note_id == old && new_path == "archive/old2.md")),
        "{facts:?}"
    );
    not_removed(&facts, &old);
    assert!(!outbox(&e, &old).contains(&"delete".to_owned()));
}

/// Deleted outside the app, then a resync in the session (an OS event overflow) and three
/// opens: Electron keeps an excluded note's record, and no delete reaches other devices while
/// the pattern covers it.
#[test]
fn an_excluded_note_deleted_outside_keeps_its_record_through_a_resync() {
    let (mut e, _store, old, _new) = two_notes();
    let rows = e.rows();
    changed(&mut e, excludes(&["archive"]));
    fs::remove_file(e.vault.join("archive/old.md")).unwrap();
    e.tier.rescan_watcher(true);
    let facts = e.facts_until(|f| matches!(f, Applied::Vault(VaultEvent::Rescanned { .. })));
    assert!(!crossed(&facts), "{facts:?}");
    quiet(&mut e);
    for _ in 0..3 {
        reopen(&mut e);
    }
    kept(&e, &rows);

    // Read again once the pattern is dropped, the file is gone: a removal like any other.
    let facts = changed(&mut e, excludes(&[]));
    assert!(
        facts
            .iter()
            .any(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == old)),
        "{facts:?}"
    );
}

/// The excluded folder renamed outside the app: its file is a new note at its new path (no
/// removal to pair it with, as in Electron), and the record it left keeps its path, with no
/// delete synced, through three opens.
#[test]
fn an_excluded_folder_renamed_outside_keeps_the_record_it_left() {
    let (mut e, _store, old, _new) = two_notes();
    let rows = e.rows();
    changed(&mut e, excludes(&["archive"]));
    fs::rename(e.vault.join("archive"), e.vault.join("kept")).unwrap();
    std::thread::sleep(QUIET);
    not_removed(&e.drain(), &old);
    for _ in 0..3 {
        reopen(&mut e);
    }
    let now = e.rows();
    assert!(now.contains(&row(&old, "archive/old.md")), "{now:?}");
    assert_eq!(now.len(), rows.len() + 1, "{now:?}");
    for (id, _) in &now {
        assert!(!outbox(&e, id).contains(&"delete".to_owned()), "{id}");
    }
}

/// A restart while the open walk is held ends with a write-back reconcile of its own: an app
/// edit whose write-back never ran reaches its file, though the stopped walk never got there.
#[test]
fn a_restart_during_the_open_walk_still_writes_back_what_the_walk_owed() {
    let mut made = None;
    let mut e = env(|store| {
        let identity = creates(store);
        made = Some(identity.clone());
        Some(identity as Arc<dyn NoteIdentity>)
    });
    let identity = made.expect("the identity");
    fs::create_dir_all(e.vault.join(".memry")).unwrap();
    fs::write(
        config_path(&e.vault),
        serde_json::to_vec(&json!({"excludePatterns": DEFAULTS})).unwrap(),
    )
    .unwrap();
    e.write("n.md", "Old\n");
    e.open();
    e.facts_until(indexed);
    let id = e.rows()[0].0.clone();
    e.edit_in_app(&identity.store, &id, "Typed in the app");
    e.close();
    e.drain();

    // More new files than two of the walk's batches: it offers the first batch while it goes on
    // listing, so once let go it looks at the stop before its end.
    for n in 0..300 {
        e.write(&format!("z-{n:03}.md"), "New\n");
    }
    identity.hold();
    e.open();
    let deadline = std::time::Instant::now() + WAIT;
    while identity.offered.lock().unwrap().is_empty() {
        assert!(
            std::time::Instant::now() < deadline,
            "the walk never offered a file"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    std::thread::scope(|s| {
        let restart = s.spawn(|| update(&e, excludes(&["archive"]), |_| {}));
        // Room for the restart to stop the held walk.
        std::thread::sleep(std::time::Duration::from_millis(300));
        identity.release();
        restart.join().unwrap().unwrap();
    });
    let deadline = std::time::Instant::now() + WAIT;
    while !e.read("n.md").contains("Typed in the app") {
        assert!(
            std::time::Instant::now() < deadline,
            "the owed write-back never ran"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Moved out of the excluded folder while the vault was closed: the open's rescan pairs the
/// file with the note the patterns cover, which keeps its id.
#[test]
fn an_excluded_note_moved_out_while_closed_keeps_its_id() {
    let (mut e, _store, old, _new) = two_notes();
    let rows = e.rows();
    changed(&mut e, excludes(&["archive"]));
    e.close();
    e.drain();
    fs::rename(
        e.vault.join("archive/old.md"),
        e.vault.join("notes/moved.md"),
    )
    .unwrap();
    e.open();
    let facts = e.facts_until(indexed);
    moved_out(&mut e, &facts, &rows, &old);
}

/// Moved out where the watcher could not see it arrive either (its destination was excluded
/// too, as an overflow loses both halves), then found by a rescan in the session (the restart
/// on the patterns dropped for it): the note keeps its id.
#[test]
fn an_excluded_note_moved_out_unseen_keeps_its_id() {
    let (mut e, _store, old, _new) = two_notes();
    let rows = e.rows();
    changed(&mut e, excludes(&["archive", "notes"]));
    fs::rename(
        e.vault.join("archive/old.md"),
        e.vault.join("notes/moved.md"),
    )
    .unwrap();
    std::thread::sleep(QUIET);
    assert!(e.drain().is_empty());
    let facts = changed(&mut e, excludes(&["archive"]));
    moved_out(&mut e, &facts, &rows, &old);
}

/// Moved out while the app watches: the watcher never sees the file leave (it does not read
/// there), so the file is a new note, as in Electron, and the record it left stays, with no
/// delete synced while the pattern covers it. The pattern dropped, that record's file is gone:
/// a removal then, while the text lives on under the new note.
#[test]
fn an_excluded_note_moved_out_live_is_a_new_note() {
    let (mut e, _store, old, _new) = two_notes();
    let rows = e.rows();
    changed(&mut e, excludes(&["archive"]));
    fs::rename(
        e.vault.join("archive/old.md"),
        e.vault.join("notes/moved.md"),
    )
    .unwrap();
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "notes/moved.md"));
    for _ in 0..3 {
        reopen(&mut e);
    }
    let now = e.rows();
    assert!(now.contains(&row(&old, "archive/old.md")), "{now:?}");
    assert_eq!(now.len(), rows.len() + 1, "{now:?}");
    for (id, _) in &now {
        assert!(!outbox(&e, id).contains(&"delete".to_owned()), "{id}");
    }
    let facts = changed(&mut e, excludes(&[]));
    assert!(
        facts
            .iter()
            .any(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == old)),
        "{facts:?}"
    );
    let moved = e.rows().into_iter().find(|(_, at)| at == "notes/moved.md");
    assert_eq!(e.body(&moved.expect("the new note").0), "Old");
}

/// After an excluded note's file moved to `notes/moved.md`: one move fact, the record at its new
/// path under its id, through three opens and the pattern dropped, and no delete synced.
fn moved_out(e: &mut Env, facts: &[Applied], rows: &[(String, String)], old: &str) {
    assert!(
        facts
            .iter()
            .any(|f| matches!(f, Applied::Renamed { note_id, new_path, .. }
            if note_id == old && new_path == "notes/moved.md")),
        "{facts:?}"
    );
    assert!(!crossed(facts), "{facts:?}");
    let mut want: Vec<(String, String)> = rows
        .iter()
        .map(|(id, at)| match id == old {
            true => (id.clone(), "notes/moved.md".to_owned()),
            false => (id.clone(), at.clone()),
        })
        .collect();
    want.sort();
    for _ in 0..3 {
        reopen(e);
    }
    let mut now = e.rows();
    now.sort();
    assert_eq!(now, want);
    let facts = changed(e, excludes(&[]));
    assert!(!crossed(&facts), "{facts:?}");
    for (id, _) in &want {
        assert!(!outbox(e, id).contains(&"delete".to_owned()), "{id}");
    }
}

/// A move out of a covered place that changes what the file is (a day to a note, or the other
/// way) pairs in the rescan but never crosses: the file is a new item, and the covered record
/// stays where it was, not removed and with no delete synced, through three opens.
fn crossed_out(config: serde_json::Value, from: &str, text: &str, to: &str, pattern: &str) {
    let (mut e, _store) = opened_keeping(config, &[(from, text), ("notes/new.md", "New\n")]);
    let rows = e.rows();
    let (kept_id, _) = rows
        .iter()
        .find(|(_, at)| at == from)
        .expect("the record")
        .clone();
    changed(&mut e, excludes(&[pattern]));
    e.close();
    e.drain();
    let to_path = e.vault.join(to);
    fs::create_dir_all(to_path.parent().unwrap()).unwrap();
    fs::rename(e.vault.join(from), to_path).unwrap();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(
        !facts.iter().any(|f| matches!(f, Applied::Removed { .. })),
        "{facts:?}"
    );
    for _ in 0..3 {
        reopen(&mut e);
    }
    let now = e.rows();
    assert!(now.contains(&row(&kept_id, from)), "{now:?}");
    assert!(
        now.iter().any(|(id, at)| at == to && *id != kept_id),
        "{now:?}"
    );
    assert_eq!(now.len(), rows.len() + 1, "{now:?}");
    for (id, _) in &now {
        assert!(!outbox(&e, id).contains(&"delete".to_owned()), "{id}");
    }
}

#[test]
fn an_excluded_day_moved_out_to_a_note_keeps_its_record() {
    let mut config = daily("journal");
    config["excludePatterns"] = json!(DEFAULTS);
    crossed_out(
        config,
        "journal/2025-01-02.md",
        "Same\n",
        "notes/x.md",
        "journal",
    );
}

#[test]
fn an_excluded_note_moved_out_to_a_day_keeps_its_record() {
    let mut config = daily("journal");
    config["excludePatterns"] = json!(DEFAULTS);
    crossed_out(
        config,
        "archive/o.md",
        "Same\n",
        "journal/2025-03-04.md",
        "archive",
    );
}
