//! Journal renames of a date format change, over a real session, a temp vault, the core's rows
//! and the shipped watcher, which keeps running through each pass: no file is lost or
//! replaced, each moved file keeps its note, and the watcher adds or removes no note after.
//! The planner's rules are pinned against Electron in `journal_format_vectors.rs`.

mod device_key;
mod vault_env;

use std::fs;
use std::path::Path;
use std::sync::Arc;

use memry_core::domain::note_positions;
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::consumer::identity::NoteIdentity;
use memry_desktop::vault::consumer::rows::RowStat;
use memry_desktop::vault::file_types::FileType;
use memry_desktop::vault::journal_format::JournalDate;
use memry_desktop::vault::journal_rename::{
    JournalRename, JournalRenameResult, JournalVault, rename_journals_for_format_change,
    revert_journal_renames,
};
use vault_env::{Env, QUIET, creates, env, indexed};

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

fn at(e: &Env, run: impl FnOnce(JournalVault<'_>) -> JournalRenameResult) -> JournalRenameResult {
    let (core, rows) = (e.core(), e.tier.rows());
    run(JournalVault {
        root: &e.vault,
        vault: &core,
        rows: &rows,
    })
}

fn rename(e: &Env, folder: &str, old: &str, new: &str) -> JournalRenameResult {
    at(e, |vault| {
        rename_journals_for_format_change(vault, folder, old, new).unwrap()
    })
}

fn revert(e: &Env, moved: &[JournalRename]) {
    at(e, |vault| {
        revert_journal_renames(vault, "journal", moved);
        JournalRenameResult::default()
    });
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

/// The facts of the pass once the watcher is quiet again: it added and removed no note.
fn settled(e: &mut Env) -> Vec<Applied> {
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(
        !facts
            .iter()
            .any(|f| matches!(f, Applied::Added { .. } | Applied::Removed { .. })),
        "{facts:?}"
    );
    facts
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
        content_hash: None,
        file_hash: None,
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

    revert(&e, &pass.moved);

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
