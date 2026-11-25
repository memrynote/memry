//! A file that owes its newer record's `aliases` (#5825, #5828): the debt is in `data.db`, so a
//! restart before the write-back's pass, or an outside edit of the body alone before it, keeps
//! the record's names, and the pass then writes them, a large file's included, its body copied
//! byte for byte. A real outside change of the file's list still wins.
//!
//! The pass is held off by a read-only folder: it cannot write the file aside, so it keeps the
//! file, as a quit or a pass that kept the file would.

use std::fs;
use std::time::{Duration, SystemTime};

use memry_core::markdown::shared::markdown_class::NOTE_MAX_BYTES;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::consumer::Applied;

use crate::index_support::until;
use crate::notes_outside_aliases::{NEWER, file_holds, id_at, pulled_note_in, record_aliases};
use crate::notes_outside_tags::{clear_outbox, edited_outside, opened, upserts};
use crate::vault_env::{Env, QUIET, indexed};

const PLAN: &str = "Sub/Plan.md";
const STALE: &str = "---\naliases: [Old]\n---\nBody\n";

#[cfg(unix)]
fn read_only(e: &Env, read_only: bool) {
    use std::os::unix::fs::PermissionsExt;
    let mode = if read_only { 0o555 } else { 0o755 };
    fs::set_permissions(e.vault.join("Sub"), fs::Permissions::from_mode(mode)).unwrap();
}

fn added(e: &mut Env, rel: &str) {
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == rel));
    assert_eq!(id_at(e, rel), "pulled");
}

/// `Sub/Plan.md` written as `text` over a record with `["Newer"]` modified at `modified_at`,
/// adopted while its folder is read-only: the owed pass ran and kept the file.
#[cfg(unix)]
fn held(text: &str, modified_at: &str) -> Env {
    let (mut e, _store) = opened();
    e.watcher_live();
    pulled_note_in(&e, Some("Sub"), ("Plan", "Body\n"), &["Newer"], modified_at);
    e.write(PLAN, text);
    read_only(&e, true);
    added(&mut e, PLAN);
    std::thread::sleep(QUIET);
    e.drain();
    assert_eq!(e.read(PLAN), text, "the pass could not write the file");
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    e
}

/// #5828: the owed write outlives a restart, and the next open writes it.
#[cfg(unix)]
#[test]
fn a_restart_between_adoption_and_the_pass_keeps_the_names_and_the_next_open_writes_them() {
    let e = held(STALE, NEWER);
    let mut e = e.restart(|store| Some(NotesIdentity::new(store)));
    read_only(&e, false);
    e.open();
    e.facts_until(indexed);
    file_holds(&mut e, PLAN, &["Newer"]);
    assert_eq!(e.read(PLAN), "---\naliases:\n  - Newer\n---\nBody\n");
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
}

/// #5828 (FOLD-5808D): an outside edit of the body alone before the pass keeps the names, and
/// the pass then writes them over the edited file.
#[cfg(unix)]
#[test]
fn a_body_only_edit_before_the_pass_keeps_the_names() {
    let mut e = held(STALE, NEWER);
    read_only(&e, false);
    edited_outside(
        &mut e,
        "pulled",
        PLAN,
        "---\naliases: [Old]\n---\nEdited outside\n",
    );
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    file_holds(&mut e, PLAN, &["Newer"]);
    assert_eq!(
        e.read(PLAN),
        "---\naliases:\n  - Newer\n---\nEdited outside\n"
    );
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
}

/// A keyless file owes the names too: a body edit that keeps it keyless keeps them.
#[cfg(unix)]
#[test]
fn a_body_only_edit_of_a_keyless_file_before_the_pass_keeps_the_names() {
    let mut e = held("Body\n", "2001-01-01T00:00:00.000Z");
    read_only(&e, false);
    edited_outside(&mut e, "pulled", PLAN, "Edited outside\n");
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    file_holds(&mut e, PLAN, &["Newer"]);
}

/// A real outside change of the list while the write is owed is the user's answer: the record
/// takes it, and the pass does not write the record's old names over it.
#[cfg(unix)]
#[test]
fn a_real_outside_alias_change_still_wins() {
    let mut e = held(STALE, NEWER);
    read_only(&e, false);
    clear_outbox(&e);
    let mine = "---\naliases: [Mine]\n---\nBody\n";
    edited_outside(&mut e, "pulled", PLAN, mine);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Mine"]);
    assert_eq!(upserts(&e, "pulled"), 1);
    std::thread::sleep(QUIET);
    e.drain();
    assert_eq!(e.read(PLAN), mine);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Mine"]);
}

fn big() -> String {
    "word\n\n".repeat(NOTE_MAX_BYTES / 6 + 1)
}

/// #5825: a large file adopted under a record newer than it, but modified in the past, shrinks
/// out of the class with an edit of its body alone, its stale list left as it was, before the
/// owed write ran. The record keeps its names, and the file takes them.
#[cfg(unix)]
#[test]
fn a_large_file_shrunk_before_its_owed_write_keeps_a_past_records_names() {
    let (mut e, _store) = opened();
    e.watcher_live();
    pulled_note_in(
        &e,
        Some("Sub"),
        ("Dump", ""),
        &["Newer"],
        "2020-01-01T00:00:00.000Z",
    );
    // The file is older than the record: written aside, dated 2001, then moved in.
    let aside = e._dir.path().join("Dump.md");
    fs::write(&aside, format!("---\naliases: [Old]\n---\n{}", big())).unwrap();
    let dated = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
    let file = fs::File::options().write(true).open(&aside).unwrap();
    file.set_modified(dated).unwrap();
    drop(file);
    fs::create_dir_all(e.vault.join("Sub")).unwrap();
    fs::rename(&aside, e.vault.join("Sub/Dump.md")).unwrap();
    read_only(&e, true);
    added(&mut e, "Sub/Dump.md");
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    std::thread::sleep(QUIET);
    e.drain();
    assert!(e.read("Sub/Dump.md").starts_with("---\naliases: [Old]\n"));

    read_only(&e, false);
    e.write("Sub/Dump.md", "---\naliases: [Old]\n---\nSmall now\n");
    file_holds(&mut e, "Sub/Dump.md", &["Newer"]);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
    assert_eq!(
        e.read("Sub/Dump.md"),
        "---\naliases:\n  - Newer\n---\nSmall now\n"
    );
}

/// #5825: a large file owing the names gets its `aliases` key alone, every other byte as it
/// was, whether it had the key, or no frontmatter at all.
#[test]
fn a_large_file_gets_its_aliases_key_with_its_body_byte_identical() {
    let big = big();
    let (mut e, _store) = opened();
    e.watcher_live();
    pulled_note_in(&e, None, ("Dump", ""), &["Newer"], NEWER);
    e.write(
        "Dump.md",
        &format!("---\ntags: [mine]\naliases: [Old]\n---\n{big}"),
    );
    added(&mut e, "Dump.md");
    file_holds(&mut e, "Dump.md", &["Newer"]);
    assert_eq!(
        e.read("Dump.md"),
        format!("---\ntags: [mine]\naliases:\n  - Newer\n---\n{big}")
    );
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);

    let (mut e, _store) = opened();
    e.watcher_live();
    pulled_note_in(&e, None, ("Dump", ""), &["Newer"], NEWER);
    e.write("Dump.md", &big);
    added(&mut e, "Dump.md");
    file_holds(&mut e, "Dump.md", &["Newer"]);
    let read = e.read("Dump.md");
    assert!(
        read.starts_with("---\naliases:\n  - Newer\n---\n"),
        "{}",
        &read[..80]
    );
    assert!(read.ends_with(&big));
    assert_eq!(
        read.len() - big.len(),
        "---\naliases:\n  - Newer\n---\n".len()
    );
}

const DUMP: &str = "Sub/Dump.md";

/// `Sub/Dump.md`, a large file holding `[Old]` and adopted under a record with `["Newer"]` while
/// its folder is read-only, edited outside to `edit` while the owed pass still cannot write, then
/// the app restarted with the folder writable: the env once the open's pass settled the debt.
#[cfg(unix)]
fn large_held_then_edited(edit: &str) -> Env {
    let (mut e, _store) = opened();
    e.watcher_live();
    pulled_note_in(&e, Some("Sub"), ("Dump", ""), &["Newer"], NEWER);
    e.write(DUMP, &format!("---\naliases: [Old]\n---\n{}", big()));
    read_only(&e, true);
    added(&mut e, DUMP);
    std::thread::sleep(QUIET);
    e.drain();
    let file_hash = |e: &Env| {
        e.core()
            .note_files()
            .by_id("pulled")
            .unwrap()
            .unwrap()
            .file_hash
    };
    let adopted = file_hash(&e);
    e.write(DUMP, edit);
    until("the edit is read", || file_hash(&e) != adopted);
    std::thread::sleep(QUIET);
    e.drain();
    assert_eq!(e.read(DUMP), edit, "the pass could not write the file");
    let mut e = e.restart(|store| Some(NotesIdentity::new(store)));
    read_only(&e, false);
    e.open();
    e.facts_until(indexed);
    until("the open's pass settles the owed aliases", || {
        !e.core().note_files().owes_file_aliases("pulled").unwrap()
    });
    std::thread::sleep(QUIET);
    e.drain();
    e
}

/// REVIEW-5836: an outside edit of a large file's list is never written over. A large file's
/// re-read does not take its list, so the owed write settles it first: the user's `[Mine]` is
/// the record's, and the file keeps it, with nothing written.
#[cfg(unix)]
#[test]
fn an_outside_alias_edit_to_a_large_file_is_never_written_over() {
    let mine = format!("---\naliases: [Mine]\n---\n{}", big());
    let e = large_held_then_edited(&mine);
    assert_eq!(e.read(DUMP), mine);
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Mine"]);
}

/// A large file whose list is still the one it had when it came to owe the record's gets the
/// record's list, its edited body as it is.
#[cfg(unix)]
#[test]
fn a_large_file_still_holding_its_stale_list_gets_the_owed_write() {
    let body = format!("Edited outside\n{}", big());
    let e = large_held_then_edited(&format!("---\naliases: [Old]\n---\n{body}"));
    assert_eq!(
        e.read(DUMP),
        format!("---\naliases:\n  - Newer\n---\n{body}")
    );
    assert_eq!(record_aliases(&e, "note", "pulled"), ["Newer"]);
}
