//! A note's versions on a real `data.db` (Step 14d, Electron `note-snapshots.ts` and
//! `notes-versions.ts`): which versions are kept, how many stay, and that a delete takes one
//! version and nothing else.

#![cfg(feature = "markdown")]

use memry_core::domain::note_snapshots::{self, Reason, Version};
use rusqlite::Connection;

use crate::editor_support::{Fixture, fixture};

/// 2026-11-06T10:00:00.000Z.
const T0: i64 = 1_793_959_200_000;
const MINUTE: i64 = 60_000;

fn sql(f: &Fixture) -> Connection {
    Connection::open(f.dir.path().join("data.db")).expect("a connection of its own")
}

fn version<'a>(note_id: &'a str, content: &'a str, reason: Reason) -> Version<'a> {
    Version {
        note_id,
        content,
        body: content,
        title: "A note",
        reason,
    }
}

/// Every row of `note_id`'s versions in the table, newest first: not capped as the list is.
fn rows(f: &Fixture, note_id: &str) -> Vec<String> {
    let conn = sql(f);
    let mut statement = conn
        .prepare(
            "SELECT content FROM note_snapshots WHERE note_id = ?1
             ORDER BY created_at DESC, rowid DESC",
        )
        .unwrap();
    statement
        .query_map([note_id], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn contents(f: &Fixture, note_id: &str) -> Vec<String> {
    let versions = f.vault.versions();
    versions
        .list(note_id)
        .expect("list")
        .into_iter()
        .map(|listed| {
            versions
                .get(&listed.id)
                .expect("get")
                .expect("kept")
                .content
        })
        .collect()
}

#[test]
fn a_version_whose_content_the_note_holds_is_not_kept_twice() {
    let f = fixture();
    let note = f.note();
    let conn = sql(&f);
    let keep =
        |content, at| note_snapshots::keep(&conn, version(&note, content, Reason::Significant), at);

    assert_eq!(keep("one", T0), Ok(true));
    assert_eq!(keep("one", T0 + MINUTE), Ok(false));
    assert_eq!(keep("two", T0 + 2 * MINUTE), Ok(true));
    assert_eq!(contents(&f, &note), ["two", "one"]);
}

#[test]
fn an_automatic_or_timer_version_waits_five_minutes_after_the_last_one() {
    let f = fixture();
    let note = f.note();
    let conn = sql(&f);
    let keep =
        |content, reason, at| note_snapshots::keep(&conn, version(&note, content, reason), at);

    assert_eq!(keep("first", Reason::Auto, T0), Ok(true));
    assert_eq!(keep("soon", Reason::Auto, T0 + 4 * MINUTE), Ok(false));
    assert_eq!(keep("soon", Reason::Timer, T0 + 4 * MINUTE), Ok(false));
    // Any other reason has no interval.
    assert_eq!(keep("edited", Reason::Significant, T0 + MINUTE), Ok(true));
    assert_eq!(keep("closed", Reason::Close, T0 + MINUTE), Ok(true));
    assert_eq!(keep("later", Reason::Timer, T0 + 6 * MINUTE), Ok(true));
    assert_eq!(keep("timer", Reason::Auto, T0 + 11 * MINUTE), Ok(true));
}

#[test]
fn a_note_keeps_its_newest_fifty_versions_and_no_other_note_loses_one() {
    let f = fixture();
    let (note, other) = (f.note(), f.note());
    let conn = sql(&f);
    note_snapshots::keep(&conn, version(&other, "other's", Reason::Close), T0).unwrap();
    for n in 0..55 {
        let content = format!("text {n}");
        let kept =
            note_snapshots::keep(&conn, version(&note, &content, Reason::Significant), T0 + n);
        assert_eq!(kept, Ok(true));
    }

    let kept = rows(&f, &note);
    assert_eq!(kept.len(), 50);
    assert_eq!(contents(&f, &note), kept);
    assert_eq!(kept.first().map(String::as_str), Some("text 54"));
    assert_eq!(kept.last().map(String::as_str), Some("text 5"));
    assert_eq!(rows(&f, &other), ["other's"]);
}

/// #4083: a tool rewriting a (locked) note's file keeps a significant version per write.
#[test]
fn significant_versions_prune_only_significant_ones() {
    let f = fixture();
    let note = f.note();
    let conn = sql(&f);
    let keep = |content: &str, reason, at| {
        note_snapshots::keep(&conn, version(&note, content, reason), at).unwrap()
    };
    keep("saved", Reason::Manual, T0);
    keep("quit", Reason::Close, T0 + 1);
    for n in 0..55 {
        keep(&format!("tool write {n}"), Reason::Significant, T0 + 2 + n);
    }

    let kept = rows(&f, &note);
    assert_eq!(kept.len(), 50);
    assert_eq!(contents(&f, &note), kept);
    assert_eq!(kept.first().map(String::as_str), Some("tool write 54"));
    assert_eq!(kept[48..], ["quit", "saved"]);
    assert!(!kept.contains(&"tool write 6".to_owned()));
}

/// A note full of the user's versions keeps the newest significant one on top, listed.
#[test]
fn a_note_full_of_the_users_versions_holds_one_significant_version_over_the_cap() {
    let f = fixture();
    let note = f.note();
    let conn = sql(&f);
    for n in 0..50 {
        let content = format!("quit {n}");
        note_snapshots::keep(&conn, version(&note, &content, Reason::Close), T0 + n).unwrap();
    }
    for n in 0..3 {
        let content = format!("tool write {n}");
        note_snapshots::keep(
            &conn,
            version(&note, &content, Reason::Significant),
            T0 + 50 + n,
        )
        .unwrap();
    }

    let kept = rows(&f, &note);
    assert_eq!(kept.len(), 51);
    assert_eq!(contents(&f, &note), kept);
    assert_eq!(kept.first().map(String::as_str), Some("tool write 2"));
    assert_eq!(kept.last().map(String::as_str), Some("quit 0"));

    note_snapshots::keep(&conn, version(&note, "quit 50", Reason::Close), T0 + 60).unwrap();
    let kept = rows(&f, &note);
    assert_eq!(
        kept.len(),
        50,
        "the user's own version prunes back to the cap"
    );
    assert_eq!(kept.first().map(String::as_str), Some("quit 50"));
    assert_eq!(kept.last().map(String::as_str), Some("quit 2"));
}

#[test]
fn versions_kept_in_one_millisecond_prune_the_first_written() {
    let f = fixture();
    let note = f.note();
    let conn = sql(&f);
    for n in 0..51 {
        let content = format!("text {n}");
        note_snapshots::keep(&conn, version(&note, &content, Reason::Significant), T0).unwrap();
    }

    let kept = rows(&f, &note);
    assert_eq!(kept.len(), 50);
    assert_eq!(kept.first().map(String::as_str), Some("text 50"));
    assert!(!kept.contains(&"text 0".to_owned()));
}

#[test]
fn a_restore_point_is_kept_as_the_newest_even_when_the_note_holds_its_text() {
    let f = fixture();
    let note = f.note();
    let conn = sql(&f);
    note_snapshots::keep(&conn, version(&note, "before", Reason::Significant), T0).unwrap();
    note_snapshots::keep(&conn, version(&note, "after", Reason::Significant), T0 + 1).unwrap();

    note_snapshots::keep_always(&conn, version(&note, "before", Reason::Significant), T0 + 2)
        .unwrap();
    assert_eq!(contents(&f, &note), ["before", "after", "before"]);
}

#[test]
fn a_change_of_ten_words_is_significant_and_code_is_not_counted() {
    let nine = "one two three four five six seven eight nine";
    assert!(!note_snapshots::is_significant("", nine));
    assert!(note_snapshots::is_significant("", &format!("{nine} ten")));
    assert!(note_snapshots::is_significant(&format!("{nine} ten"), ""));
    assert!(!note_snapshots::is_significant(
        "a",
        &format!("a ```{nine} ten```")
    ));
}

#[test]
fn a_delete_takes_that_version_alone_and_an_unknown_one_is_no_delete() {
    let f = fixture();
    let (note, other) = (f.note(), f.note());
    let conn = sql(&f);
    for (id, content, at) in [
        (&note, "one", T0),
        (&note, "two", T0 + 1),
        (&other, "one", T0),
    ] {
        note_snapshots::keep(&conn, version(id, content, Reason::Significant), at).unwrap();
    }
    let versions = f.vault.versions();
    let listed = versions.list(&note).unwrap();
    let two = &listed[0];
    assert_eq!(
        versions.get(&two.id).unwrap().map(|k| k.content),
        Some("two".to_owned())
    );

    assert_eq!(versions.delete(&two.id), Ok(true));
    assert_eq!(versions.get(&two.id), Ok(None));
    assert_eq!(versions.delete(&two.id), Ok(false));
    assert_eq!(versions.delete("no-such-version"), Ok(false));
    assert_eq!(rows(&f, &note), ["one"]);
    assert_eq!(rows(&f, &other), ["one"]);
    assert_eq!(
        f.vault.write_back().title(&note),
        Ok(Some("A note".to_owned()))
    );
}

#[test]
fn a_close_version_carries_the_title_and_outlives_a_relaunch() {
    let f = fixture();
    let note = f.note();
    let versions = f.vault.versions();
    let file = "---\ntags: [a]\n---\nwords in the file\n";

    assert_eq!(versions.keep_close(&note, file), Ok(true));
    assert_eq!(versions.keep_close(&note, file), Ok(false));
    assert_eq!(versions.keep_close("no-such-note", file), Ok(false));

    let f = f.relaunch();
    let listed = f.vault.versions().list(&note).unwrap();
    let [only] = listed.as_slice() else {
        panic!("one version: {listed:?}");
    };
    assert_eq!(
        (only.title.as_str(), only.reason.as_str(), only.word_count),
        ("A note", "close", 4)
    );
    assert_eq!(only.created_at.len(), "2026-11-06T10:00:00.000Z".len());
    assert_eq!(contents(&f, &note), [file]);
}

#[test]
fn a_text_seen_again_moves_its_version_up_so_it_is_not_the_next_pruned() {
    let f = fixture();
    let note = f.note();
    let conn = sql(&f);
    let keep = |content: &str, at| {
        note_snapshots::keep(&conn, version(&note, content, Reason::Significant), at)
    };
    keep("A", T0).unwrap();
    for n in 1..50 {
        keep(&format!("text {n}"), T0 + n).unwrap();
    }
    assert_eq!(keep("A", T0 + 100), Ok(false), "held already");
    assert_eq!(rows(&f, &note).first().map(String::as_str), Some("A"));
    keep("one more", T0 + 101).unwrap();

    let kept = rows(&f, &note);
    assert_eq!(kept.len(), 50);
    assert!(
        kept.contains(&"A".to_owned()),
        "the only copy of A was pruned"
    );
    assert!(!kept.contains(&"text 1".to_owned()));
    // A clock behind never moves it back: seen again, it is the newest.
    keep("A", T0).unwrap();
    assert_eq!(rows(&f, &note)[0], "A");
}

#[test]
fn the_version_just_kept_is_never_pruned_even_when_the_clock_is_behind() {
    let f = fixture();
    let note = f.note();
    let conn = sql(&f);
    for n in 0..50 {
        let content = format!("text {n}");
        note_snapshots::keep(&conn, version(&note, &content, Reason::Significant), T0 + n).unwrap();
    }
    let behind = T0 - 24 * 60 * MINUTE;
    let kept = note_snapshots::keep(&conn, version(&note, "behind", Reason::Close), behind);
    assert_eq!(kept, Ok(true));
    // A restore point, then one more, on a clock further behind: each is the newest, and the
    // oldest of the others go, never one kept on the clock behind.
    note_snapshots::keep_always(
        &conn,
        version(&note, "point", Reason::Significant),
        behind - 1,
    )
    .unwrap();
    let later = note_snapshots::keep(&conn, version(&note, "later", Reason::Close), behind - 2);
    assert_eq!(later, Ok(true));

    let kept = rows(&f, &note);
    assert_eq!(kept.len(), 50);
    assert_eq!(kept[..3], ["later", "point", "behind"], "{kept:?}");
    assert!(!kept.contains(&"text 2".to_owned()) && kept.contains(&"text 3".to_owned()));
}
