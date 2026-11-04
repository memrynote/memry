//! A folder renamed or moved in the app (Step 13h, #3530) under the running vault tier: every
//! note in it is recorded before the folder moves, the folder moves with its bytes, records,
//! rows, folder records and order follow, one `Renamed` fact (`MoveKind::Moved`) goes out per
//! note, and the watcher reports none of it back as deletes and new notes, a file note (no hash)
//! included.
//!
//! | Test                                                              | Rule                                  |
//! | ----------------------------------------------------------------- | ------------------------------------- |
//! | a folder rename carries its notes, records and order              | `renameFolderCommand`                 |
//! | a folder held open moves entry by entry, its subfolder with it    | #2206, `moveDirectory`                |
//! | a folder whose notes cannot follow goes back                      | one step, as a note's move            |
//! | a move the disk refuses halfway rolls back and records nothing    | `move_dir`'s rollback                 |
//! | a rename that changes only case respells the folder               | the folder's own spelling is free     |
//! | a folder rename the app cannot make is refused                    | #2531, no replace, journal, hidden    |
//! | a note with an unsettled move holds its folder back               | one move per note                     |
//! | the path links to the folder's notes follow it                    | `rewriteInboundWikiLinks`             |
//! | a folder move a crash cut short finishes on the next open         | the folder's record, one transaction  |
//! | a folder move a crash cut short before the disk is forgotten      | the folder's record                   |
//! | a folder move into an ignored or linked folder is refused         | as a note's move                      |
//! | an outside delete in the fixture is reported                      | control for the silent watcher        |
//! | after a refused move an outside delete is reported                | the removal record is withdrawn       |
//! | a case-only rename that respells a parent is refused              | the folder's own name only            |
//! | a folder move that puts a note under an ignored path is refused   | `excludePatterns` with a slash        |
//! | a move that panics leaves no record of the folder's going         | the removal record is withdrawn       |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::io;
use std::sync::Arc;

use index_support::until;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::domain::notes::app_move::{AppMoved, BeginError};
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::folders::FolderConfigInput;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::links::NoteLinks;
use memry_desktop::notes::service::{NotesService, Trash};
use memry_desktop::vault::activity::ActivityFilter;
use memry_desktop::vault::config::{VaultConfigPatch, write_vault_config};
use memry_desktop::vault::consumer::{Applied, ChangeSource, MoveKind};
use memry_desktop::vault::layout::DEFAULT_EXCLUDE_PATTERNS;
use memry_desktop::vault::move_dir::{Step, simulated_hold};
use memry_desktop::vault::trash::move_to_trash;
use vault_env::{Env, QUIET, env, indexed};

/// Longer than the watcher's debounce and rename window: a pause mid-move lets it look at the
/// disk while the rows still name the old paths, as a large or entry-wise move does.
pub(crate) const MID_MOVE: std::time::Duration = std::time::Duration::from_millis(1500);

use crate::notes_link_rewrite::{id_at, opened as opened_indexed};

fn opened() -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    opened_with(move_to_trash)
}

pub(crate) fn opened_with(trash: Trash) -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.open();
    e.facts_until(indexed);
    armed(&mut e);
    let store = kept.expect("the store");
    let notes = NotesService::with_trash(e.tier.clone(), store.clone(), trash);
    (e, notes, store)
}

pub(crate) fn note(title: &str, folder: &str) -> NewNoteFile {
    NewNoteFile {
        title: title.into(),
        content: format!("About {title}"),
        folder: Some(folder.into()),
        ..NewNoteFile::default()
    }
}

/// A PDF at `rel` with a record and a row with no hash, known to the tier after a reopen.
fn file_note(e: &mut Env, store: &Arc<dyn SecureStore>, rel: &str) -> String {
    fs::write(e.vault.join(rel), b"%PDF-1.4 bytes").unwrap();
    let core = e.core();
    let id = core
        .notes_writer(store.clone())
        .unwrap()
        .create("Doc".into(), Some("Work".into()))
        .unwrap();
    core.note_files()
        .upsert_stat(NoteFileStat {
            note_id: id.clone(),
            path: rel.into(),
            file_type: "pdf".into(),
            mime_type: Some("application/pdf".into()),
            file_size: Some(14),
            content_hash: None,
            file_hash: None,
            indexed_at: 0,
        })
        .unwrap();
    drop(core);
    e.close();
    e.open();
    e.facts_until(indexed);
    armed(e);
    id
}

/// Waits until the watcher reports: a scratch note written and deleted, each seen. It arms a
/// moment after the open, and a move made before that would pass every "the watcher reported
/// nothing" below for want of a watcher.
pub(crate) fn armed(e: &mut Env) {
    e.write("armed.md", "armed\n");
    let facts = e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "armed.md"));
    let Some(Applied::Added { note_id, .. }) = facts.last() else {
        unreachable!("facts_until ends on the fact it waits for")
    };
    let id = note_id.clone();
    fs::remove_file(e.vault.join("armed.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == id));
    e.drain();
}

fn query<T: Send + 'static>(
    e: &Env,
    sql: &'static str,
    read: fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Vec<T> {
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            let mut statement = conn.prepare(sql).unwrap();
            let rows = statement.query_map([], read).unwrap();
            Ok(rows.collect::<Result<Vec<_>, _>>().unwrap())
        })
        .unwrap()
}

/// `(id, folder_path)` of every live note, by id.
pub(crate) fn folders_of_notes(e: &Env) -> Vec<(String, Option<String>)> {
    let sql = "SELECT id, folder_path FROM notes WHERE deleted_at IS NULL ORDER BY id";
    query(e, sql, |row| Ok((row.get(0)?, row.get(1)?)))
}

pub(crate) fn live_folder_records(e: &Env) -> Vec<(String, Option<String>)> {
    let sql = "SELECT path, icon FROM folders WHERE deleted_at IS NULL ORDER BY path";
    query(e, sql, |row| Ok((row.get(0)?, row.get(1)?)))
}

pub(crate) fn slots(e: &Env) -> Vec<(String, String, i64)> {
    let sql = "SELECT path, folder_path, position FROM note_positions ORDER BY path";
    query(e, sql, |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
}

fn pending(e: &Env, store: &Arc<dyn SecureStore>) -> usize {
    let writer = e.core().notes_writer(store.clone()).unwrap();
    writer.pending_app_moves().unwrap().len()
}

/// The row facts once the watcher had time to report: any but the app's `Renamed` is the move
/// taken for an outside one.
pub(crate) fn row_facts(e: &mut Env) -> Vec<Applied> {
    std::thread::sleep(QUIET);
    let mut facts: Vec<Applied> = e
        .drain()
        .into_iter()
        .filter(|fact| {
            matches!(
                fact,
                Applied::Changed {
                    source: ChangeSource::Watcher,
                    ..
                } | Applied::Added { .. }
                    | Applied::Removed { .. }
                    | Applied::Renamed { .. }
            )
        })
        .collect();
    facts.sort_by_key(|fact| format!("{fact:?}"));
    facts
}

fn renamed(id: &str, old: &str, new: &str) -> Applied {
    Applied::Renamed {
        note_id: id.to_owned(),
        old_path: old.to_owned(),
        new_path: new.to_owned(),
        kind: MoveKind::Moved,
    }
}

fn sorted(mut facts: Vec<Applied>) -> Vec<Applied> {
    facts.sort_by_key(|fact| format!("{fact:?}"));
    facts
}

pub(crate) fn rows(e: &Env) -> Vec<(String, String)> {
    let mut rows = e.rows();
    rows.sort();
    rows
}

pub(crate) fn activity_is_empty(e: &Env) {
    let mut activity = e.tier.activity().list(100, ActivityFilter::All).entries;
    activity.retain(|entry| entry.path.as_deref() != Some("armed.md"));
    assert!(
        activity.is_empty(),
        "the watcher reported the app's move: {activity:?}"
    );
}

/// `Work` holding `Plan.md`, `Sub/Deep.md` and a PDF, recorded with an icon, and ordered by
/// hand in the root and in `Work`.
pub(crate) struct Work {
    pub e: Env,
    pub notes: Arc<NotesService>,
    pub store: Arc<dyn SecureStore>,
    pub plan: String,
    pub deep: String,
    pub doc: String,
}

fn work() -> Work {
    work_with(move_to_trash)
}

pub(crate) fn work_with(trash: Trash) -> Work {
    let (mut e, notes, store) = opened_with(trash);
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Work").unwrap();
    let plan = notes.create(&open, note("Plan", "Work")).unwrap().id;
    let deep = notes.create(&open, note("Deep", "Work/Sub")).unwrap().id;
    let icon = FolderConfigInput {
        icon: Some(Some("lucide:book".into())),
        template: None,
        inherit: None,
    };
    notes.set_folder_config(&open, "Work", &icon).unwrap();
    drop(open);
    let doc = file_note(&mut e, &store, "Work/Doc.pdf");
    let open = e.session.current().unwrap();
    open.vault
        .note_positions()
        .reorder("Work", vec!["Work/Sub".into(), "Work/Plan.md".into()])
        .unwrap();
    e.drain();
    Work {
        e,
        notes,
        store,
        plan,
        deep,
        doc,
    }
}

#[test]
fn a_folder_rename_carries_its_notes_records_and_order() {
    let Work {
        mut e,
        notes,
        store,
        plan,
        deep,
        doc,
    } = work();
    let open = e.session.current().unwrap();
    let bytes = e.read("Work/Plan.md");

    // Once the folder moved, before its notes follow, each note's move is on record; the
    // watcher looks meanwhile and takes no file for removed.
    let mut seen = None;
    notes
        .rename_folder_checked(&open, "Work", "Projects", &mut |_| Ok(()), &mut || {
            seen = Some((
                e.vault.join("Projects/Sub/Deep.md").exists(),
                pending(&e, &store),
            ));
            std::thread::sleep(MID_MOVE);
            Ok(())
        })
        .unwrap();
    assert_eq!(seen, Some((true, 3)));

    assert!(!e.vault.join("Work").exists());
    assert_eq!(e.read("Projects/Plan.md"), bytes);
    assert_eq!(
        e.read("Projects/.folder.md"),
        "---\nicon: 'lucide:book'\n---\n\n"
    );
    let mut expected_rows = vec![
        (plan.clone(), "Projects/Plan.md".to_owned()),
        (deep.clone(), "Projects/Sub/Deep.md".to_owned()),
        (doc.clone(), "Projects/Doc.pdf".to_owned()),
    ];
    expected_rows.sort();
    assert_eq!(rows(&e), expected_rows);
    let mut expected_folders = vec![
        (plan.clone(), Some("Projects".to_owned())),
        (deep.clone(), Some("Projects/Sub".to_owned())),
        (doc.clone(), Some("Projects".to_owned())),
    ];
    expected_folders.sort();
    assert_eq!(folders_of_notes(&e), expected_folders);
    assert_eq!(
        live_folder_records(&e),
        [("Projects".to_owned(), Some("lucide:book".to_owned()))]
    );
    assert_eq!(
        slots(&e),
        [
            ("Projects/Plan.md".to_owned(), "Projects".to_owned(), 1),
            ("Projects/Sub".to_owned(), "Projects".to_owned(), 0),
        ]
    );
    assert_eq!(pending(&e, &store), 0);
    assert_eq!(
        row_facts(&mut e),
        sorted(vec![
            renamed(&plan, "Work/Plan.md", "Projects/Plan.md"),
            renamed(&deep, "Work/Sub/Deep.md", "Projects/Sub/Deep.md"),
            renamed(&doc, "Work/Doc.pdf", "Projects/Doc.pdf"),
        ])
    );
    activity_is_empty(&e);
}

/// Windows refuses to rename a folder something beneath holds open (#2206): the tree moves entry
/// by entry through a hidden staging folder, a subfolder with it, and the watcher still takes
/// none of it for deletes.
#[test]
fn a_folder_held_open_moves_entry_by_entry_its_subfolder_with_it() {
    let Work {
        mut e,
        notes,
        store,
        plan,
        deep,
        doc,
    } = work();
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Archive").unwrap();
    e.drain();
    // The watcher looks once the first entries went into the staging folder.
    let mut entries = 0;
    let mut held = |step: Step<'_>| match step {
        Step::Whole { .. } => Err(simulated_hold()),
        Step::Entry { .. } => {
            entries += 1;
            if entries == 3 {
                std::thread::sleep(MID_MOVE);
            }
            Ok(())
        }
        _ => Ok(()),
    };
    notes
        .rename_folder_checked(&open, "Work", "Archive/Work", &mut held, &mut || Ok(()))
        .unwrap();

    assert!(!e.vault.join("Work").exists());
    assert!(e.vault.join("Archive/Work/Sub/Deep.md").exists());
    assert_eq!(
        folders_of_notes(&e).into_iter().find(|(id, _)| *id == deep),
        Some((deep.clone(), Some("Archive/Work/Sub".to_owned())))
    );
    assert_eq!(pending(&e, &store), 0);
    assert_eq!(
        row_facts(&mut e),
        sorted(vec![
            renamed(&plan, "Work/Plan.md", "Archive/Work/Plan.md"),
            renamed(&deep, "Work/Sub/Deep.md", "Archive/Work/Sub/Deep.md"),
            renamed(&doc, "Work/Doc.pdf", "Archive/Work/Doc.pdf"),
        ])
    );
    activity_is_empty(&e);
}

#[test]
fn a_folder_whose_notes_cannot_follow_goes_back() {
    let Work {
        mut e,
        notes,
        store,
        ..
    } = work();
    let open = e.session.current().unwrap();
    let before = rows(&e);
    let failed =
        notes.rename_folder_checked(&open, "Work", "Projects", &mut |_| Ok(()), &mut || {
            Err(NotesError::Io(io::Error::other("injected")))
        });
    assert!(matches!(failed, Err(NotesError::Io(_))), "{failed:?}");
    assert!(e.vault.join("Work/Sub/Deep.md").exists());
    assert!(!e.vault.join("Projects").exists());
    assert_eq!(rows(&e), before);
    assert_eq!(live_folder_records(&e)[0].0, "Work");
    assert_eq!(
        pending(&e, &store),
        0,
        "the records of the undone move stayed"
    );
    assert_eq!(row_facts(&mut e), []);
    activity_is_empty(&e);
}

#[test]
fn a_move_the_disk_refuses_halfway_rolls_back_and_records_nothing() {
    let Work {
        mut e,
        notes,
        store,
        ..
    } = work();
    let open = e.session.current().unwrap();
    let before = rows(&e);
    let mut entries = 0;
    let mut refused = |step: Step<'_>| match step {
        Step::Whole { .. } => Err(simulated_hold()),
        Step::Entry { .. } => {
            entries += 1;
            if entries == 2 {
                Err(io::Error::other("injected"))
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    };
    let failed =
        notes.rename_folder_checked(&open, "Work", "Projects", &mut refused, &mut || Ok(()));
    assert!(matches!(failed, Err(NotesError::Io(_))), "{failed:?}");
    assert!(e.vault.join("Work/Plan.md").exists());
    assert!(e.vault.join("Work/Doc.pdf").exists());
    assert!(!e.vault.join("Projects").exists());
    assert_eq!(rows(&e), before);
    assert_eq!(pending(&e, &store), 0);
    assert_eq!(row_facts(&mut e), []);
}

#[test]
fn a_rename_that_changes_only_case_respells_the_folder() {
    let (mut e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let plan = notes.create(&open, note("Plan", "work")).unwrap().id;
    e.drain();
    notes.rename_folder(&open, "work", "Work").unwrap();
    let names: Vec<String> = fs::read_dir(&e.vault)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.eq_ignore_ascii_case("work"))
        .collect();
    assert_eq!(names, ["Work"]);
    assert_eq!(rows(&e), [(plan.clone(), "Work/Plan.md".to_owned())]);
    assert_eq!(
        row_facts(&mut e),
        [renamed(&plan, "work/Plan.md", "Work/Plan.md")]
    );
}

#[test]
fn a_folder_rename_the_app_cannot_make_is_refused() {
    let Work { e, notes, .. } = work();
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Taken").unwrap();
    let refused = |old: &str, new: &str| notes.rename_folder(&open, old, new).unwrap_err();
    assert!(matches!(
        refused("Gone", "Else"),
        NotesError::FolderNotFound
    ));
    assert!(matches!(refused("Work", "Taken"), NotesError::NameConflict));
    assert!(matches!(refused("Work", "taken"), NotesError::NameConflict));
    assert!(matches!(
        refused("Work", "Work/Sub/Deeper"),
        NotesError::InvalidFolder
    ));
    assert!(matches!(
        refused("Work", ".hidden"),
        NotesError::InvalidFolder
    ));
    assert!(matches!(
        refused("Work", "attachments/Work"),
        NotesError::InvalidFolder
    ));
    assert!(matches!(refused("Work", " pad"), NotesError::InvalidFolder));
    assert!(matches!(
        refused("Work", "Missing/Work"),
        NotesError::FolderNotFound
    ));
    assert!(matches!(
        refused("journal", "Diary"),
        NotesError::FolderHoldsJournal
    ));
    assert!(e.vault.join("Work/Plan.md").exists());
}

#[test]
fn a_note_with_an_unsettled_move_holds_its_folder_back() {
    let Work {
        e,
        notes,
        store,
        plan,
        ..
    } = work();
    let open = e.session.current().unwrap();
    let moved = AppMoved {
        old_path: "Work/Plan.md",
        new_path: "Work/Elsewhere.md",
        title: None,
        keeps_kind: true,
    };
    e.core()
        .notes_writer(store.clone())
        .unwrap()
        .begin_app_move(&plan, moved)
        .unwrap();
    let refused = notes.rename_folder(&open, "Work", "Projects");
    assert!(
        matches!(refused, Err(NotesError::MovePending(BeginError::Unsettled))),
        "{refused:?}"
    );
    assert!(e.vault.join("Work/Plan.md").exists());
    assert_eq!(pending(&e, &store), 1, "only the unsettled one");
}

#[test]
fn the_path_links_to_the_folders_notes_follow_it() {
    let (mut e, notes, _) = opened_indexed(&[
        ("Work/Plan.md", "Plan body.\n"),
        ("Ideas.md", "See [[Work/Plan]] and [[Plan]].\n"),
    ]);
    let open = e.session.current().unwrap();
    let plan = id_at(&e, "Work/Plan.md");
    let links = NoteLinks::new(&open);
    until("the links indexed", || {
        !links.get(&plan).unwrap().incoming.is_empty()
    });
    e.drain();

    notes.rename_folder(&open, "Work", "Projects").unwrap();
    assert_eq!(e.read("Ideas.md"), "See [[Projects/Plan]] and [[Plan]].\n");
}

/// A crash once the folder moved and before its notes followed (the probe of the review): the
/// next open finishes each note's move, and the folder's records and manual order follow it
/// too, so no peer keeps a folder at the old path.
#[test]
fn a_folder_move_a_crash_cut_short_finishes_on_the_next_open() {
    let Work {
        mut e,
        store,
        plan,
        deep,
        doc,
        ..
    } = work();
    let writer = e.core().notes_writer(store.clone()).unwrap();
    let moved = |old: &'static str, new: &'static str| AppMoved {
        old_path: old,
        new_path: new,
        title: None,
        keeps_kind: true,
    };
    let moves = [
        (plan.as_str(), moved("Work/Plan.md", "Projects/Plan.md")),
        (
            deep.as_str(),
            moved("Work/Sub/Deep.md", "Projects/Sub/Deep.md"),
        ),
        (doc.as_str(), moved("Work/Doc.pdf", "Projects/Doc.pdf")),
    ];
    writer
        .begin_folder_move("Work", "Projects", &moves)
        .unwrap();
    drop(writer);
    e.close();
    fs::rename(e.vault.join("Work"), e.vault.join("Projects")).unwrap();
    e.open();
    e.facts_until(indexed);

    let mut expected_rows = vec![
        (plan.clone(), "Projects/Plan.md".to_owned()),
        (deep.clone(), "Projects/Sub/Deep.md".to_owned()),
        (doc.clone(), "Projects/Doc.pdf".to_owned()),
    ];
    expected_rows.sort();
    assert_eq!(rows(&e), expected_rows);
    assert_eq!(
        live_folder_records(&e),
        [("Projects".to_owned(), Some("lucide:book".to_owned()))]
    );
    assert_eq!(
        slots(&e),
        [
            ("Projects/Plan.md".to_owned(), "Projects".to_owned(), 1),
            ("Projects/Sub".to_owned(), "Projects".to_owned(), 0),
        ]
    );
    assert_eq!(pending(&e, &store), 0);
}

/// A crash after the records and before the folder moved: the next open forgets them all, and
/// the folder, its notes and its records stay where they are.
#[test]
fn a_folder_move_a_crash_cut_short_before_the_disk_is_forgotten() {
    let Work {
        mut e, store, plan, ..
    } = work();
    let before = rows(&e);
    let writer = e.core().notes_writer(store.clone()).unwrap();
    let moved = AppMoved {
        old_path: "Work/Plan.md",
        new_path: "Projects/Plan.md",
        title: None,
        keeps_kind: true,
    };
    writer
        .begin_folder_move("Work", "Projects", &[(plan.as_str(), moved)])
        .unwrap();
    drop(writer);
    e.close();
    e.open();
    e.facts_until(indexed);

    assert_eq!(rows(&e), before);
    assert_eq!(
        live_folder_records(&e),
        [("Work".to_owned(), Some("lucide:book".to_owned()))]
    );
    assert_eq!(pending(&e, &store), 0);
    let writer = e.core().notes_writer(store.clone()).unwrap();
    assert_eq!(writer.pending_folder_moves().unwrap(), []);
}

/// A target the vault ignores (`node_modules` by default) would drop the folder's notes out of
/// it at the next open, and one reached through a link is walked by nothing; both are refused,
/// as a note's own move refuses them.
#[test]
fn a_folder_move_into_an_ignored_or_linked_folder_is_refused() {
    let Work { e, notes, .. } = work();
    let open = e.session.current().unwrap();
    let refused = |old: &str, new: &str| notes.rename_folder(&open, old, new).unwrap_err();
    // Below the root, where the tree's own filter (first segment only) does not hide it.
    fs::create_dir(e.vault.join("Other")).unwrap();
    assert!(matches!(
        refused("Work", "Other/node_modules"),
        NotesError::InvalidFolder
    ));
    #[cfg(unix)]
    {
        fs::create_dir(e.vault.join("Real")).unwrap();
        std::os::unix::fs::symlink(e.vault.join("Real"), e.vault.join("Link")).unwrap();
        assert!(matches!(
            refused("Work", "Link/Work"),
            NotesError::InvalidFolder
        ));
    }
    assert!(e.vault.join("Work/Plan.md").exists());
}

pub(crate) fn removed_ids(facts: &[Applied]) -> Vec<String> {
    facts
        .iter()
        .filter_map(|fact| match fact {
            Applied::Removed { note_id, .. } => Some(note_id.clone()),
            _ => None,
        })
        .collect()
}

/// A note written into `Work` from outside the app, seen by the watcher. Its delete is reported
/// once the watcher armed; a delete of a note the app wrote in an earlier session is not (#3912),
/// so the controls below use this one.
pub(crate) fn outside_note(e: &mut Env) -> String {
    e.write("Work/Outside.md", "outside\n");
    let facts =
        e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "Work/Outside.md"));
    let Some(Applied::Added { note_id, .. }) = facts.last() else {
        unreachable!("facts_until ends on the fact it waits for")
    };
    note_id.clone()
}

/// The control for every "the watcher reported nothing" above: in this fixture an outside
/// delete in `Work` is reported, so their silence is the move's.
#[test]
fn an_outside_delete_in_the_fixture_is_reported() {
    let Work { mut e, .. } = work();
    let plan = outside_note(&mut e);
    fs::remove_file(e.vault.join("Work/Outside.md")).unwrap();
    let facts =
        e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == plan));
    assert_eq!(removed_ids(&facts), [plan]);
}

/// A move the disk refused before anything moved leaves no record of the folder's going: a
/// delete made outside the app afterwards is reported.
#[test]
fn after_a_refused_move_an_outside_delete_is_reported() {
    let Work { mut e, notes, .. } = work();
    let plan = outside_note(&mut e);
    let open = e.session.current().unwrap();
    let mut refused = |step: Step<'_>| match step {
        Step::Whole { .. } => Err(io::Error::other("injected")),
        _ => Ok(()),
    };
    let failed =
        notes.rename_folder_checked(&open, "Work", "Projects", &mut refused, &mut || Ok(()));
    assert!(matches!(failed, Err(NotesError::Io(_))), "{failed:?}");
    e.drain();

    fs::remove_file(e.vault.join("Work/Outside.md")).unwrap();
    let facts =
        e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == plan));
    assert_eq!(removed_ids(&facts), [plan]);
}

/// Only the moved folder's own name may change case: `Work/Sub` to `work/sub` respells `Work`,
/// which the move does not own. Folded, the target is the folder itself, so it is refused as a
/// move into itself on every volume.
#[test]
fn a_case_only_rename_that_respells_a_parent_is_refused() {
    let Work { e, notes, .. } = work();
    let open = e.session.current().unwrap();
    let refused = notes.rename_folder(&open, "Work/Sub", "work/sub");
    assert!(
        matches!(refused, Err(NotesError::InvalidFolder)),
        "{refused:?}"
    );
    assert!(e.vault.join("Work/Sub/Deep.md").exists());
    let names: Vec<String> = fs::read_dir(e.vault.join("Work"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert!(names.contains(&"Sub".to_owned()), "{names:?}");
}

/// A pattern with a slash names a path at any depth (`vendor/cache`): `Old` holding `cache`
/// moved to `Lib/vendor` puts a note under `Lib/vendor/cache`, which the next open would drop,
/// so the move is refused though the target itself is neither hidden nor ignored.
#[test]
fn a_folder_move_that_puts_a_note_under_an_ignored_path_is_refused() {
    let (e, notes, _) = opened();
    let mut patterns = DEFAULT_EXCLUDE_PATTERNS.map(str::to_owned).to_vec();
    patterns.push("vendor/cache".into());
    let patch = VaultConfigPatch {
        exclude_patterns: Some(patterns),
        ..VaultConfigPatch::default()
    };
    write_vault_config(&e.vault, &patch).unwrap();
    let open = e.session.current().unwrap();
    notes.create(&open, note("Cached", "Old/cache")).unwrap();
    fs::create_dir(e.vault.join("Lib")).unwrap();
    let refused = notes.rename_folder(&open, "Old", "Lib/vendor");
    assert!(
        matches!(refused, Err(NotesError::InvalidFolder)),
        "{refused:?}"
    );
    assert!(e.vault.join("Old/cache/Cached.md").exists());
}

/// A panic halfway through the move (here, in its first step) leaves no record of the folder's
/// going behind: a note written into it and deleted outside the app afterwards is reported.
#[test]
fn a_move_that_panics_leaves_no_record_of_the_folders_going() {
    let Work { mut e, notes, .. } = work();
    let open = e.session.current().unwrap();
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        notes.rename_folder_checked(
            &open,
            "Work",
            "Projects",
            &mut |_| panic!("injected"),
            &mut || Ok(()),
        )
    }));
    assert!(panicked.is_err());
    e.drain();

    let later = outside_note(&mut e);
    fs::remove_file(e.vault.join("Work/Outside.md")).unwrap();
    let facts =
        e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == later));
    assert_eq!(removed_ids(&facts), [later]);
}
