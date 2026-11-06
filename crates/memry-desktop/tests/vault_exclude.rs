//! An exclude pattern change in Settings (Step 13m-7b-3, #3530), on an open vault whose notes
//! the app's own identity (`NotesIdentity`) names. Electron's `updateConfig` restarts its
//! watcher on the new patterns and rebuilds its derived index; it deletes no note record and
//! syncs no delete, and a file that stops matching comes back under its record's id. Here the
//! watcher and the consumer restart on the saved patterns, and every row stays.
//!
//! | Test                                                            | Rule                                    |
//! | --------------------------------------------------------------- | --------------------------------------- |
//! | excluding a folder keeps its notes, and including it takes ...  | no record deleted, same id, no duplicate |
//! | an excluded note still takes the app's edits                    | its row and write-back stay             |
//! | excluding the journal folder keeps every day                    | a day is a day by folder and format     |
//! | an exclude change killed at any step keeps every note           | the save is the only durable step       |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::VaultConfigPatch;
use memry_desktop::vault::consumer::Applied;
use serde_json::json;
use vault_env::{Env, QUIET, WAIT, indexed};

use crate::journal_change_crash::{change_killed, reopened};
use crate::journal_folder::{DAY, crossed, daily, make_day, outbox, reopen, row};
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

/// The row of an excluded note stays, so an edit in the app still reaches its file.
#[test]
fn an_excluded_note_still_takes_the_apps_edits() {
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
/// which the patterns do not change. A day made then is a day, through three opens.
#[test]
fn excluding_the_journal_folder_keeps_every_day() {
    let (mut e, store) = opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let notes = NotesService::new(e.tier.clone(), store);
    let facts = changed(&mut e, excludes(&["journal"]));
    assert!(!crossed(&facts), "{facts:?}");
    make_day(&notes, &e, "2025-01-06");
    for _ in 0..3 {
        reopen(&mut e);
    }
    let rows = e.rows();
    assert!(
        rows.contains(&row(DAY, "journal/2025-01-02.md")),
        "{rows:?}"
    );
    assert!(
        rows.contains(&row("j2025-01-06", "journal/2025-01-06.md")),
        "{rows:?}"
    );
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
