//! The record of a journal setting change that moves the days (Step 13m-7b-2b, #3530), against
//! real SQLite: one record at a time, forgotten only by the change it names, and a record of
//! another version kept.
//!
//! | Test                                                        | Rule                               |
//! | ----------------------------------------------------------- | ---------------------------------- |
//! | a journal change is recorded once and only it forgets it    | `notes.journal_change.v1`          |
//! | a version 1 record reads as this build writes it            | `notes.journal_change.v1`, compat  |
//! | a record another build wrote is reported and kept           | `notes.journal_change.v1`, compat  |

#![cfg(feature = "markdown")]

#[allow(unused_imports)]
use crate::note_identity_support;

use memry_core::domain::notes::app_move::BeginError;
use memry_core::domain::notes::journal_change::{
    self, JournalChangeRecorded, JournalSetting, KEY, PendingJournalChange,
};
use note_identity_support::{open, run};

fn setting(folder: &str, format: &str) -> JournalSetting {
    JournalSetting {
        folder: folder.into(),
        format: format.into(),
    }
}

fn change(to: &str) -> PendingJournalChange {
    PendingJournalChange {
        from: setting("journal", "YYYY-MM-DD"),
        to: setting(to, "YYYY-MM-DD"),
        made: vec![to.into()],
    }
}

fn pending(db: &memry_core::storage::Db) -> Option<JournalChangeRecorded> {
    run(db, |conn| journal_change::pending(conn))
}

fn put(db: &memry_core::storage::Db, value: &str) {
    let value = value.to_owned();
    run(db, move |conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            [KEY, value.as_str()],
        )
        .unwrap();
        Ok(())
    });
}

#[test]
fn a_journal_change_is_recorded_once_and_only_it_forgets_it() {
    let db = open("journal-change");
    let diary = change("Diary");
    assert_eq!(pending(&db), None);
    run(&db, |conn| Ok(journal_change::begin(conn, &diary))).unwrap();
    assert_eq!(
        pending(&db),
        Some(JournalChangeRecorded::Change(diary.clone()))
    );

    let again = run(&db, |conn| {
        Ok(journal_change::begin(conn, &change("Other")))
    });
    assert!(matches!(again, Err(BeginError::Unsettled)), "{again:?}");
    assert!(!run(&db, |conn| journal_change::abandon(
        conn,
        &change("Other")
    )));
    assert!(run(&db, |conn| journal_change::abandon(conn, &diary)));
    assert_eq!(pending(&db), None);
}

/// The record's JSON is a format that crosses builds: a version 1 record another build wrote,
/// with a field this one does not know and no `made`, reads as written.
#[test]
fn a_version_1_record_reads_as_this_build_writes_it() {
    let db = open("journal-change-v1");
    put(
        &db,
        r#"{"version":1,"from":{"folder":"journal","format":"YYYY-MM-DD"},"to":{"folder":"Diary","format":"YYYY/YYYY-MM-DD"},"later":true}"#,
    );
    let read = PendingJournalChange {
        from: setting("journal", "YYYY-MM-DD"),
        to: setting("Diary", "YYYY/YYYY-MM-DD"),
        made: Vec::new(),
    };
    assert_eq!(
        pending(&db),
        Some(JournalChangeRecorded::Change(read.clone()))
    );
    assert!(run(&db, |conn| journal_change::abandon(conn, &read)));

    run(&db, |conn| {
        Ok(journal_change::begin(conn, &change("Diary")))
    })
    .unwrap();
    let written: String = run(&db, |conn| {
        Ok(conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [KEY], |row| {
                row.get(0)
            })
            .unwrap())
    });
    assert_eq!(
        written,
        r#"{"version":1,"from":{"folder":"journal","format":"YYYY-MM-DD"},"to":{"folder":"Diary","format":"YYYY-MM-DD"},"made":["Diary"]}"#
    );
}

/// A record of a version this build does not know is reported, refuses the next change, and is
/// never forgotten here.
#[test]
fn a_record_another_build_wrote_is_reported_and_kept() {
    let db = open("journal-change-unreadable");
    put(&db, r#"{"version":2}"#);
    let unreadable = JournalChangeRecorded::Unreadable("a version 2 record".into());
    assert_eq!(pending(&db), Some(unreadable.clone()));
    let again = run(&db, |conn| {
        Ok(journal_change::begin(conn, &change("Diary")))
    });
    assert!(matches!(again, Err(BeginError::Unreadable(_))), "{again:?}");
    assert!(!run(&db, |conn| journal_change::abandon(
        conn,
        &change("Diary")
    )));
    assert_eq!(pending(&db), Some(unreadable));
}
