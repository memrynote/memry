//! Journal renames of a date format change, over a real session, a temp vault, the core's rows
//! and the shipped watcher, which keeps running through each pass: no file is lost or
//! replaced, each moved file keeps its note, and the watcher adds or removes no note after.
//! The planner's rules are pinned against Electron in `journal_format_vectors.rs`.

mod device_key;
mod vault_env;

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use memry_core::domain::note_positions;
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal,
};
use memry_desktop::vault::consumer::rows::RowStat;
use memry_desktop::vault::file_types::FileType;
use memry_desktop::vault::journal_format::JournalDate;
use memry_desktop::vault::journal_rename::{
    JournalRename, JournalRenameResult, JournalVault, rename_journals_for_format_change,
    revert_journal_renames,
};
use vault_env::{Creates, Env, QUIET, creates, env, indexed};

const DAILY: &str = "YYYY-MM-DD";
const WEEKDAY: &str = "YYYY-MM-DD dddd";
const NESTED: &str = "YYYY/MMMM/YYYY-MM-DD";

/// An open vault holding `files` under `journal/`, each a note with a row.
fn opened(files: &[(&str, &str)]) -> Env {
    open_with(true, files)
}

fn open_with(notes: bool, files: &[(&str, &str)]) -> Env {
    let mut e = env(|store| notes.then(|| creates(store) as Arc<dyn NoteIdentity>));
    fs::create_dir_all(e.vault.join("journal")).unwrap();
    for (name, text) in files {
        e.write(&format!("journal/{name}"), text);
    }
    e.open();
    e.facts_until(indexed);
    e
}

/// An open vault holding `files` under `journal/`, each a note with a row, whose identity
/// answers `answer` when the watcher reports a file removed.
fn watched(answer: Removal, files: &[(&str, &str)]) -> (Env, Arc<OnRemoved>) {
    let identity = Arc::new(Mutex::new(None));
    let mut e = env(|store| {
        let on_removed = Arc::new(OnRemoved {
            creates: creates(store),
            answer,
            asked: Mutex::default(),
        });
        *identity.lock().unwrap() = Some(on_removed.clone());
        Some(on_removed as Arc<dyn NoteIdentity>)
    });
    for (name, text) in files {
        e.write(&format!("journal/{name}"), text);
    }
    e.open();
    e.facts_until(indexed);
    let identity = identity.lock().unwrap().take().unwrap();
    (e, identity)
}

/// Waits until the consumer applied an outside edit of each of `names` (under `journal/`), in
/// whatever order the watcher reports them.
fn until_changed(e: &mut Env, names: &[&str]) {
    let left: Mutex<HashSet<String>> =
        Mutex::new(names.iter().map(|name| format!("journal/{name}")).collect());
    e.facts_until(|fact| {
        let mut left = left.lock().unwrap();
        if let Applied::Changed { path, .. } = fact {
            left.remove(path);
        }
        left.is_empty()
    });
}

fn at<T>(e: &Env, run: impl FnOnce(JournalVault<'_>) -> T) -> T {
    let core = e.core();
    run(JournalVault {
        root: &e.vault,
        vault: &core,
        tier: &e.tier,
    })
}

fn rename(e: &Env, folder: &str, old: &str, new: &str) -> JournalRenameResult {
    at(e, |vault| {
        rename_journals_for_format_change(vault, folder, old, new).unwrap()
    })
}

/// The renames that did not go back.
fn revert(e: &Env, moved: &[JournalRename]) -> Vec<JournalRename> {
    at(e, |vault| revert_journal_renames(vault, "journal", moved))
}

fn moved(from: &str, to: &str, date: &str) -> JournalRename {
    JournalRename {
        from: from.into(),
        to: to.into(),
        date: JournalDate::from_iso(date).unwrap(),
    }
}

fn result(moved: Vec<JournalRename>, skipped: usize) -> JournalRenameResult {
    JournalRenameResult {
        moved,
        skipped,
        failed: 0,
    }
}

/// The facts of the pass once the watcher is quiet again: it added and removed no note, and
/// every row still holds its hashes. An identity that keeps a removed file's note (`Creates`)
/// publishes no fact and clears the row's hashes instead.
fn settled(e: &mut Env) -> Vec<Applied> {
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(
        !facts
            .iter()
            .any(|f| matches!(f, Applied::Added { .. } | Applied::Removed { .. })),
        "{facts:?}"
    );
    let files = e.core().note_files();
    for (_, path) in e.rows() {
        let row = files.by_path(&path).unwrap().unwrap();
        assert!(
            row.content_hash.is_some() && row.file_hash.is_some(),
            "{row:?}"
        );
    }
    facts
}

/// [`creates`], answering `answer` for the note of a file the watcher reports removed, and
/// remembering which.
struct OnRemoved {
    creates: Arc<Creates>,
    answer: Removal,
    asked: Mutex<Vec<String>>,
}

impl NoteIdentity for OnRemoved {
    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        self.creates.adopt_or_create(ctx, file)
    }

    fn on_removed(
        &self,
        _: &IdentityCtx<'_>,
        note_id: &str,
        _: &str,
    ) -> Result<Removal, IdentityError> {
        self.asked.lock().unwrap().push(note_id.to_owned());
        Ok(self.answer)
    }

    fn on_renamed(
        &self,
        _: &IdentityCtx<'_>,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<(), IdentityError> {
        Ok(())
    }
}

fn id_at(e: &Env, path: &str) -> String {
    let rows = e.rows();
    rows.iter()
        .find(|(_, p)| p == path)
        .unwrap_or_else(|| panic!("no row at {path}: {rows:?}"))
        .0
        .clone()
}

/// Every file and folder under the journal folder, relative to it, sorted.
fn tree(e: &Env) -> Vec<String> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let name = format!("{prefix}{}", entry.file_name().to_str().unwrap());
            if entry.file_type().unwrap().is_dir() {
                out.push(format!("{name}/"));
                walk(&entry.path(), &format!("{name}/"), out);
            } else {
                out.push(name);
            }
        }
    }
    let mut out = Vec::new();
    walk(&e.vault.join("journal"), "", &mut out);
    out.sort();
    out
}

fn order(e: &Env, folder: &str, paths: &[&str]) {
    let (folder, paths) = (
        folder.to_owned(),
        paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(),
    );
    e.core()
        .db_handle()
        .call_blocking(move |conn| note_positions::reorder(conn, &folder, &paths))
        .unwrap();
}

fn slot(e: &Env, path: &str) -> Option<i64> {
    let path = path.to_owned();
    e.core()
        .db_handle()
        .read_blocking(note_positions::all)
        .unwrap()
        .into_iter()
        .find(|row| row.path == path)
        .map(|row| row.position)
}

#[test]
fn a_journal_moves_with_its_row_and_its_order_slot_and_keeps_its_note() {
    let mut e = opened(&[
        ("2026-09-25.md", "entry for 2026-09-25\n"),
        ("ideas.md", "not a journal\n"),
    ]);
    let id = id_at(&e, "journal/2026-09-25.md");
    order(
        &e,
        "journal",
        &[
            "journal/ideas.md",
            "journal/x.md",
            "journal/y.md",
            "journal/2026-09-25.md",
        ],
    );

    let result = rename(&e, "journal", DAILY, WEEKDAY);

    let to = "2026-09-25 Friday.md";
    assert_eq!(
        result,
        self::result(vec![moved("2026-09-25.md", to, "2026-09-25")], 0)
    );
    assert_eq!(tree(&e), ["2026-09-25 Friday.md", "ideas.md"]);
    assert_eq!(e.read(&format!("journal/{to}")), "entry for 2026-09-25\n");
    assert_eq!(id_at(&e, &format!("journal/{to}")), id);
    assert_eq!(e.rows().len(), 2);
    assert_eq!(slot(&e, &format!("journal/{to}")), Some(3));
    assert_eq!(slot(&e, "journal/2026-09-25.md"), None);
    let facts = settled(&mut e);
    assert!(facts.contains(&Applied::Renamed {
        note_id: id.clone(),
        old_path: "journal/2026-09-25.md".into(),
        new_path: format!("journal/{to}"),
    }));
    assert_eq!(id_at(&e, &format!("journal/{to}")), id);
    assert_eq!(e.rows().len(), 2);
}

/// Two journals with the same bytes, which the watcher reported this session (an outside edit),
/// so what it last reported names each one's note. Were their moves taken for deletes, the new
/// names would not tell the two apart and no move would pair: an identity that deletes a
/// removed file's note would delete both, and one that keeps it would strip both rows' hashes.
#[test]
fn journals_the_watcher_reported_with_the_same_bytes_move_and_keep_their_notes() {
    for answer in [Removal::Deleted, Removal::Kept] {
        let names = ["2026-09-25.md", "2026-09-26.md"];
        let (mut e, identity) = watched(answer, &names.map(|name| (name, "first\n")));
        let ids = names.map(|name| id_at(&e, &format!("journal/{name}")));
        for name in names {
            e.write(&format!("journal/{name}"), "same\n");
        }
        until_changed(&mut e, &names);

        let result = rename(&e, "journal", DAILY, WEEKDAY);

        assert_eq!(result.moved.len(), 2, "{answer:?}: {result:?}");
        settled(&mut e);
        assert!(identity.asked.lock().unwrap().is_empty(), "{answer:?}");
        let to = ["2026-09-25 Friday.md", "2026-09-26 Saturday.md"];
        for (id, name) in ids.iter().zip(to) {
            assert_eq!(&id_at(&e, &format!("journal/{name}")), id, "{answer:?}");
            assert_eq!(e.read(&format!("journal/{name}")), "same\n");
        }
        assert_eq!(e.rows().len(), 2, "{answer:?}");
    }
}

/// Journals the watcher reported in year and month folders, flattened: the folders the pass
/// empties go too, and their removal is the app's own as well. Taken for an outside delete, it
/// would stand for the notes the watcher last saw in them.
#[test]
fn journals_reported_in_folders_the_pass_empties_keep_their_notes() {
    let names = [
        "2025/January/2025-01-14.md",
        "2025/January/2025-01-15.md",
        "2025/February/2025-02-01.md",
    ];
    let flat = ["2025-01-14.md", "2025-01-15.md", "2025-02-01.md"];
    for answer in [Removal::Deleted, Removal::Kept] {
        let (mut e, identity) = watched(answer, &names.map(|name| (name, "first\n")));
        let ids = names.map(|name| id_at(&e, &format!("journal/{name}")));
        for (name, text) in names.iter().zip(["same\n", "same\n", "other\n"]) {
            e.write(&format!("journal/{name}"), text);
        }
        until_changed(&mut e, &names);

        let result = rename(&e, "journal", NESTED, DAILY);

        assert_eq!(result.moved.len(), 3, "{answer:?}: {result:?}");
        assert_eq!(tree(&e), flat);
        settled(&mut e);
        assert!(identity.asked.lock().unwrap().is_empty(), "{answer:?}");
        for (id, name) in ids.iter().zip(flat) {
            assert_eq!(&id_at(&e, &format!("journal/{name}")), id, "{answer:?}");
        }
    }
}

/// The record that a pruned folder goes ends once the folder is back: the folder made again,
/// and later moved out of the vault (to the Trash), is a delete of the note it holds.
#[test]
fn a_pruned_folder_made_again_and_moved_out_is_a_delete() {
    let (mut e, identity) = watched(Removal::Deleted, &[("2025/January/2025-01-14.md", "x\n")]);
    rename(&e, "journal", NESTED, DAILY);
    settled(&mut e);
    e.write("journal/2025/notes.md", "a note\n");
    let added = e.facts_until(
        |f| matches!(f, Applied::Added { path, .. } if path == "journal/2025/notes.md"),
    );
    let Some(Applied::Added { note_id: id, .. }) = added.last().cloned() else {
        unreachable!()
    };

    fs::rename(e.vault.join("journal/2025"), e._dir.path().join("Trash")).unwrap();

    e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == id));
    assert_eq!(identity.asked.lock().unwrap().as_slice(), [id]);
}

/// A delete by another program while a move waits to try again is that program's. The move
/// fails on a month folder it cannot write in, so it retries after 50, 150 and 450 ms; the
/// file is deleted during the longest wait. The record that the old name goes is up only while
/// the move is tried, never while it waits.
#[cfg(unix)]
#[test]
fn a_delete_while_a_move_waits_to_retry_is_still_a_delete() {
    use std::os::unix::fs::PermissionsExt;
    let (mut e, identity) = watched(Removal::Deleted, &[("2025-01-14.md", "entry\n")]);
    let id = id_at(&e, "journal/2025-01-14.md");
    let month = e.vault.join("journal/2025/January");
    fs::create_dir_all(&month).unwrap();
    fs::set_permissions(&month, fs::Permissions::from_mode(0o555)).unwrap();
    let source = e.vault.join("journal/2025-01-14.md");
    let deleter = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        fs::remove_file(source).unwrap();
    });

    let result = rename(&e, "journal", DAILY, NESTED);
    deleter.join().unwrap();
    fs::set_permissions(&month, fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(result.failed, 1, "{result:?}");
    e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == id));
    assert_eq!(identity.asked.lock().unwrap().as_slice(), [id]);
}

#[test]
fn a_taken_name_leaves_both_files_and_rows_as_they_are() {
    let mut e = opened(&[
        ("2026-09-26.md", "entry for 2026-09-26\n"),
        ("2026-09-26 Saturday.md", "obsidian note\n"),
    ]);
    let rows = e.rows();

    let result = rename(&e, "journal", DAILY, WEEKDAY);

    assert_eq!(result, self::result(vec![], 1));
    assert_eq!(e.read("journal/2026-09-26.md"), "entry for 2026-09-26\n");
    assert_eq!(e.read("journal/2026-09-26 Saturday.md"), "obsidian note\n");
    settled(&mut e);
    assert_eq!(e.rows(), rows);
}

#[test]
fn a_name_another_note_still_holds_is_not_taken() {
    let mut e = opened(&[("2026-09-26.md", "entry\n")]);
    let (core, rows) = (e.core(), e.tier.rows());
    let session = rows.session_for(&core).unwrap();
    let stale = RowStat {
        file_type: FileType::Markdown,
        size: 0,
        content_hash: Some("stale".into()),
        file_hash: Some("stale".into()),
    };
    rows.reserve(session, "stale", "journal/2026-09-26 saturday.md", stale)
        .unwrap();
    e.drain();

    let result = rename(&e, "journal", DAILY, WEEKDAY);

    assert_eq!(result, self::result(vec![], 1));
    assert_eq!(tree(&e), ["2026-09-26.md"]);
    settled(&mut e);
}

#[test]
fn a_format_that_cannot_name_every_date_renames_nothing() {
    let mut e = opened(&[("2026-09-25.md", "entry\n")]);

    let result = rename(&e, "journal", DAILY, "YYYY-MM");

    assert_eq!(result, JournalRenameResult::default());
    assert_eq!(tree(&e), ["2026-09-25.md"]);
    settled(&mut e);
}

#[test]
fn a_file_no_row_names_is_renamed_too() {
    let mut e = open_with(false, &[("2026-09-27.md", "external\n")]);
    assert!(e.rows().is_empty());

    let result = rename(&e, "/journal/", DAILY, WEEKDAY);

    let to = "2026-09-27 Sunday.md";
    assert_eq!(
        result,
        self::result(vec![moved("2026-09-27.md", to, "2026-09-27")], 0)
    );
    assert_eq!(tree(&e), [to]);
    assert_eq!(e.read(&format!("journal/{to}")), "external\n");
    settled(&mut e);
}

#[test]
fn entries_move_into_year_and_month_folders_and_back_and_emptied_folders_go() {
    let mut e = opened(&[
        ("2025-01-14.md", "entry\n"),
        ("ideas.md", "not a journal\n"),
    ]);
    let id = id_at(&e, "journal/2025-01-14.md");

    let nested = rename(&e, "journal", DAILY, NESTED);

    let deep = "2025/January/2025-01-14.md";
    assert_eq!(
        nested,
        result(vec![moved("2025-01-14.md", deep, "2025-01-14")], 0)
    );
    assert_eq!(tree(&e), ["2025/", "2025/January/", deep, "ideas.md"]);
    assert_eq!(id_at(&e, &format!("journal/{deep}")), id);
    settled(&mut e);

    e.write("journal/2025/notes.md", "kept\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "journal/2025/notes.md"));
    let flat = rename(&e, "journal", NESTED, DAILY);

    assert_eq!(
        flat,
        result(vec![moved(deep, "2025-01-14.md", "2025-01-14")], 0)
    );
    // `January` emptied and went; `2025` still holds a file and stays, and so does `journal`.
    assert_eq!(
        tree(&e),
        ["2025-01-14.md", "2025/", "2025/notes.md", "ideas.md"]
    );
    assert_eq!(id_at(&e, "journal/2025-01-14.md"), id);
    settled(&mut e);
}

#[test]
fn a_reverted_pass_puts_files_rows_and_order_slots_back() {
    let mut e = opened(&[("2025-01-14.md", "one\n"), ("2025-01-15.md", "two\n")]);
    let (first, second) = (
        id_at(&e, "journal/2025-01-14.md"),
        id_at(&e, "journal/2025-01-15.md"),
    );
    order(
        &e,
        "journal",
        &["journal/x.md", "journal/y.md", "journal/2025-01-14.md"],
    );
    let pass = rename(&e, "journal", DAILY, NESTED);
    assert_eq!(pass.moved.len(), 2);

    let left = revert(&e, &pass.moved);

    assert_eq!(left, []);
    assert_eq!(tree(&e), ["2025-01-14.md", "2025-01-15.md"]);
    assert_eq!(id_at(&e, "journal/2025-01-14.md"), first);
    assert_eq!(id_at(&e, "journal/2025-01-15.md"), second);
    assert_eq!(slot(&e, "journal/2025-01-14.md"), Some(2));
    settled(&mut e);
}

/// A crash after a file moved and before its row followed leaves the file at the new name and
/// the row at the old one. The next open pairs the two as a move: the note keeps its id, and the
/// file is neither a new note nor the old one removed.
#[test]
fn a_crash_between_a_file_and_its_row_is_paired_on_the_next_open() {
    let mut e = opened(&[("2026-09-25.md", "entry for 2026-09-25\n")]);
    let id = id_at(&e, "journal/2026-09-25.md");
    e.close();
    let to = "journal/2026-09-25 Friday.md";
    fs::rename(e.vault.join("journal/2026-09-25.md"), e.vault.join(to)).unwrap();
    e.drain();

    e.open();
    e.facts_until(indexed);

    assert_eq!(id_at(&e, to), id);
    assert_eq!(e.rows().len(), 1);
    settled(&mut e);
    // The pass run again finds the entry already renamed.
    assert_eq!(
        rename(&e, "journal", DAILY, WEEKDAY),
        JournalRenameResult::default()
    );
    assert_eq!(tree(&e), ["2026-09-25 Friday.md"]);
}

/// The vault root is never a journal folder, so its files keep their names.
#[test]
fn a_missing_journal_folder_renames_nothing() {
    let e = opened(&[("2026-09-25.md", "entry\n")]);
    e.write("2026-09-26.md", "a note at the root\n");

    for folder in ["daily", " / "] {
        let result = rename(&e, folder, DAILY, WEEKDAY);
        assert_eq!(result, JournalRenameResult::default(), "{folder}");
    }
    assert_eq!(tree(&e), ["2026-09-25.md"]);
    assert_eq!(e.read("2026-09-26.md"), "a note at the root\n");
}

/// `C:` is a drive on Windows: joined to the vault it would name a folder outside it.
#[cfg(windows)]
#[test]
fn a_journal_folder_that_names_a_drive_renames_nothing() {
    let e = opened(&[("2026-09-25.md", "entry\n")]);

    for folder in ["C:", "C:/journal"] {
        let result = rename(&e, folder, DAILY, WEEKDAY);
        assert_eq!(result, JournalRenameResult::default(), "{folder}");
    }
    assert_eq!(tree(&e), ["2026-09-25.md"]);
}

/// The listing passes over links, as Electron's did: a link named like an entry is not one, and
/// a link at a new name is free to the plan, so the move itself refuses it.
#[cfg(unix)]
#[test]
fn a_link_at_the_new_name_is_never_replaced_and_a_link_is_never_renamed() {
    use std::os::unix::fs::symlink;
    let mut e = opened(&[("2026-09-25.md", "entry\n")]);
    let link = e.vault.join("journal/2026-09-25 Friday.md");
    symlink("../elsewhere.md", &link).unwrap();
    symlink("../elsewhere.md", e.vault.join("journal/2026-09-20.md")).unwrap();

    let result = rename(&e, "journal", DAILY, WEEKDAY);

    assert_eq!(result, self::result(vec![], 1));
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(e.read("journal/2026-09-25.md"), "entry\n");
    assert_eq!(
        tree(&e),
        ["2026-09-20.md", "2026-09-25 Friday.md", "2026-09-25.md"]
    );
    settled(&mut e);
}

/// On a volume that folds case the new name is the file's own; the move respells it.
#[test]
fn a_change_of_case_respells_the_file_and_keeps_its_note() {
    let mut e = opened(&[("Week 2025-01-14.md", "entry\n")]);
    let id = id_at(&e, "journal/Week 2025-01-14.md");

    let result = rename(&e, "journal", "Week YYYY-MM-DD", "week YYYY-MM-DD");

    let to = "week 2025-01-14.md";
    assert_eq!(
        result,
        self::result(vec![moved("Week 2025-01-14.md", to, "2025-01-14")], 0)
    );
    assert_eq!(tree(&e), [to]);
    assert_eq!(e.read(&format!("journal/{to}")), "entry\n");
    assert_eq!(id_at(&e, &format!("journal/{to}")), id);
    settled(&mut e);
}

/// A file that took an entry's old name meanwhile keeps it: that entry stays at its new name,
/// with its note, and is the one the revert hands back.
#[test]
fn a_revert_leaves_an_entry_whose_old_name_is_taken_and_returns_it() {
    let mut e = opened(&[("2025-01-14.md", "one\n"), ("2025-01-15.md", "two\n")]);
    let first = id_at(&e, "journal/2025-01-14.md");
    let pass = rename(&e, "journal", DAILY, NESTED);
    settled(&mut e);
    e.write("journal/2025-01-14.md", "a new note\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "journal/2025-01-14.md"));

    let left = revert(&e, &pass.moved);

    let deep = "2025/January/2025-01-14.md";
    assert_eq!(left, [moved("2025-01-14.md", deep, "2025-01-14")]);
    assert_eq!(
        tree(&e),
        [
            "2025-01-14.md",
            "2025-01-15.md",
            "2025/",
            "2025/January/",
            deep
        ]
    );
    assert_eq!(e.read("journal/2025-01-14.md"), "a new note\n");
    assert_eq!(id_at(&e, &format!("journal/{deep}")), first);
    settled(&mut e);
}

/// A format is taken as the config holds it: no `..` folder, and a backslash is a folder
/// separator, so every new name stays in the journal folder.
#[test]
fn a_format_is_taken_in_its_canonical_form_and_stays_in_the_journal_folder() {
    let mut e = opened(&[("2025-01-14.md", "entry\n")]);
    let id = id_at(&e, "journal/2025-01-14.md");

    let up = rename(&e, "journal", DAILY, "../../YYYY-MM-DD dddd");

    let to = "2025-01-14 Tuesday.md";
    assert_eq!(
        up,
        result(vec![moved("2025-01-14.md", to, "2025-01-14")], 0)
    );
    assert_eq!(tree(&e), [to]);

    let nested = rename(
        &e,
        "journal",
        " ./YYYY-MM-DD dddd ",
        "YYYY\\MMMM\\YYYY-MM-DD",
    );

    let deep = "2025/January/2025-01-14.md";
    assert_eq!(nested, result(vec![moved(to, deep, "2025-01-14")], 0));
    assert_eq!(tree(&e), ["2025/", "2025/January/", deep]);
    assert_eq!(id_at(&e, &format!("journal/{deep}")), id);
    let names = |dir: &Path| {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| !name.starts_with('.'))
            .collect();
        names.sort();
        names
    };
    assert_eq!(names(&e.vault), ["attachments", "journal"]);
    assert_eq!(names(e._dir.path()), ["app", "vault"]);
    settled(&mut e);
}

/// A folder of the journal folder that links outside the vault is not a way out: the entry
/// that would move into it stays, and nothing lands outside.
#[cfg(unix)]
#[test]
fn a_new_name_through_a_linked_folder_out_of_the_vault_is_not_taken() {
    let mut e = opened(&[("2025-01-14.md", "entry\n")]);
    let outside = e._dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, e.vault.join("journal/2025")).unwrap();

    let result = rename(&e, "journal", DAILY, NESTED);

    assert_eq!(
        result,
        JournalRenameResult {
            moved: vec![],
            skipped: 0,
            failed: 1,
        }
    );
    assert_eq!(e.read("journal/2025-01-14.md"), "entry\n");
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    settled(&mut e);
}

/// A move that fails removes the folders it created for the new name, and only those: an
/// empty year folder that was there stays. The file stays too, with its note. The file is made
/// immovable (macOS: the immutable flag; Windows: held open without delete sharing).
#[cfg(any(target_os = "macos", windows))]
#[test]
fn a_move_that_fails_leaves_no_folder_behind() {
    let mut e = opened(&[("2025-01-14.md", "entry\n"), ("ideas.md", "kept\n")]);
    let id = id_at(&e, "journal/2025-01-14.md");
    fs::create_dir(e.vault.join("journal/2025")).unwrap();
    let source = e.vault.join("journal/2025-01-14.md");
    let pinned = Pinned::new(&source);

    let result = rename(&e, "journal", DAILY, NESTED);
    drop(pinned);

    assert_eq!(
        result,
        JournalRenameResult {
            moved: vec![],
            skipped: 0,
            failed: 1,
        }
    );
    assert_eq!(tree(&e), ["2025-01-14.md", "2025/", "ideas.md"]);
    assert_eq!(id_at(&e, "journal/2025-01-14.md"), id);
    settled(&mut e);
}

/// A folder the pass could not remove, because it holds a note, keeps no record of its own:
/// moved out of the vault later (to the Trash), it is a delete of that note.
#[test]
fn a_folder_the_pass_leaves_and_that_is_moved_out_is_a_delete() {
    let (mut e, identity) = watched(
        Removal::Deleted,
        &[
            ("2025/January/2025-01-14.md", "x\n"),
            ("2025/notes.md", "a note\n"),
        ],
    );
    let id = id_at(&e, "journal/2025/notes.md");
    rename(&e, "journal", NESTED, DAILY);
    assert_eq!(tree(&e), ["2025-01-14.md", "2025/", "2025/notes.md"]);
    settled(&mut e);

    fs::rename(e.vault.join("journal/2025"), e._dir.path().join("Trash")).unwrap();

    e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == id));
    assert_eq!(identity.asked.lock().unwrap().as_slice(), [id]);
}

/// A move that fails withdraws its record that the file's old name would go: the file deleted
/// outside the app afterwards is still a delete. The move fails on a year folder it cannot
/// write in, which leaves the file itself untouched, so no event of it clears the record.
#[cfg(unix)]
#[test]
fn a_move_that_fails_leaves_a_later_delete_to_the_watcher() {
    use std::os::unix::fs::PermissionsExt;
    let (mut e, identity) = watched(Removal::Deleted, &[("2025-01-14.md", "entry\n")]);
    let id = id_at(&e, "journal/2025-01-14.md");
    let year = e.vault.join("journal/2025");
    fs::create_dir(&year).unwrap();
    fs::set_permissions(&year, fs::Permissions::from_mode(0o555)).unwrap();

    let result = rename(&e, "journal", DAILY, NESTED);
    fs::set_permissions(&year, fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(result.failed, 1, "{result:?}");
    settled(&mut e);
    fs::remove_file(e.vault.join("journal/2025-01-14.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == id));
    assert_eq!(identity.asked.lock().unwrap().as_slice(), [id]);
}

/// A file no rename can move until dropped.
#[cfg(target_os = "macos")]
struct Pinned(std::ffi::CString);

#[cfg(target_os = "macos")]
impl Pinned {
    fn new(path: &Path) -> Self {
        let path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
        // SAFETY: a NUL-terminated path that outlives the call.
        assert_eq!(
            unsafe { libc::chflags(path.as_ptr(), libc::UF_IMMUTABLE) },
            0
        );
        Self(path)
    }
}

#[cfg(target_os = "macos")]
impl Drop for Pinned {
    fn drop(&mut self) {
        // SAFETY: as in `new`.
        unsafe { libc::chflags(self.0.as_ptr(), 0) };
    }
}

/// The handle is held only to be closed when dropped.
#[cfg(windows)]
struct Pinned(#[expect(dead_code, reason = "held open until dropped")] fs::File);

#[cfg(windows)]
impl Pinned {
    fn new(path: &Path) -> Self {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ only: a rename needs delete sharing.
        Self(
            fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(path)
                .unwrap(),
        )
    }
}

/// On a volume that tells case apart, a name that differs from the file's only in case is
/// another entry. A link to the file there, symbolic or hard, is not the file under a new
/// spelling: it is never replaced, and never left beside the file as a second name of it.
#[cfg(unix)]
#[test]
fn a_link_to_the_file_at_its_new_case_is_never_taken_for_the_file() {
    let probe = tempfile::tempdir().unwrap();
    fs::write(probe.path().join("Case"), "").unwrap();
    if probe.path().join("case").exists() {
        return eprintln!("skipped: the temp folder folds case");
    }
    for hard in [false, true] {
        let mut e = open_with(false, &[("Week 2025-01-14.md", "entry\n")]);
        let (source, link) = (
            e.vault.join("journal/Week 2025-01-14.md"),
            e.vault.join("journal/week 2025-01-14.md"),
        );
        if hard {
            fs::hard_link(&source, &link).unwrap();
        } else {
            std::os::unix::fs::symlink("Week 2025-01-14.md", &link).unwrap();
        }

        let result = rename(&e, "journal", "Week YYYY-MM-DD", "week YYYY-MM-DD");

        assert_eq!(result, self::result(vec![], 1), "hard: {hard}");
        assert_eq!(e.read("journal/Week 2025-01-14.md"), "entry\n");
        let kind = fs::symlink_metadata(&link).unwrap().file_type();
        assert_eq!(kind.is_symlink(), !hard);
        settled(&mut e);
    }
}

/// A format too large to compile matches no name: nothing is renamed, and nothing panics.
#[test]
fn a_format_too_large_to_compile_renames_nothing() {
    let mut e = opened(&[("2025-01-14.md", "entry\n")]);

    let result = rename(
        &e,
        "journal",
        DAILY,
        &format!("YYYY-MM-DD {}", "MMMM".repeat(20_000)),
    );

    assert_eq!(result, JournalRenameResult::default());
    assert_eq!(tree(&e), ["2025-01-14.md"]);
    settled(&mut e);
}
