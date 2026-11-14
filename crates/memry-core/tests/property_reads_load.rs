//! Settings' list of the notes holding a property (`listNotesWithProperty`, #4629) costs a fixed
//! number of SQL statements, the same for one note as for hundreds. Counted in statements on
//! both databases, as `link_reads_load.rs` counts them: a lookup per note would grow the count
//! with the list.

use std::sync::atomic::{AtomicUsize, Ordering};

use memry_core::domain::note_properties::{self, NoteWithProperty};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use rusqlite::{Connection, params};

const MANY: usize = 400;

static STATEMENTS: AtomicUsize = AtomicUsize::new(0);

fn count(event: TraceEvent<'_>) {
    if matches!(event, TraceEvent::Stmt(_, sql) if !sql.starts_with("-- ")) {
        STATEMENTS.fetch_add(1, Ordering::SeqCst);
    }
}

fn statements<T>(data: &Connection, index: &Connection, read: impl FnOnce() -> T) -> (T, usize) {
    STATEMENTS.store(0, Ordering::SeqCst);
    data.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(count));
    index.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(count));
    let out = read();
    data.trace_v2(TraceEventCodes::empty(), None);
    index.trace_v2(TraceEventCodes::empty(), None);
    (out, STATEMENTS.load(Ordering::SeqCst))
}

/// `MANY` notes `n{i}` titled `Note {i}`, each holding `rating`; `n0` alone holds `mood: good`,
/// and the journal day `journal/2026-11-05.md`, a file with no note row, holds `mood: 3`.
fn vault() -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    let tx = data.transaction().expect("tx");
    let file = |id: &str, path: &str| {
        tx.execute(
            "INSERT INTO note_files (note_id, path, file_type, indexed_at) \
             VALUES (?1, ?2, 'markdown', 0)",
            params![id, path],
        )
        .expect("file row");
    };
    for i in 0..MANY {
        let id = format!("n{i}");
        tx.execute(
            "INSERT INTO notes (id, title, emoji, folder_path, file_type, created_at, modified_at) \
             VALUES (?1, ?2, ?3, '', 'markdown', 0, 0)",
            params![id, format!("Note {i}"), (i == 0).then_some("🌱")],
        )
        .expect("note");
        file(&id, &format!("Note {i}.md"));
    }
    file("j2026-11-05", "journal/2026-11-05.md");
    tx.commit().expect("commit");
    let tx = index.transaction().expect("tx");
    let row = |id: &str, name: &str, value: &str, type_name: &str| {
        tx.execute(
            "INSERT INTO note_properties (note_id, name, value, type) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, value, type_name],
        )
        .expect("property row");
    };
    for i in 0..MANY {
        row(&format!("n{i}"), "rating", &i.to_string(), "number");
    }
    row("n0", "mood", "good", "number");
    row("j2026-11-05", "mood", "3", "number");
    // A row whose note has no file is left out.
    row("gone", "mood", "4", "number");
    tx.commit().expect("commit");
    (data, index)
}

#[test]
fn notes_with_a_property_cost_the_same_statements_for_one_note_or_hundreds() {
    let (data, index) = vault();
    let (mood, few) = statements(&data, &index, || {
        note_properties::named(&data, &index, "mood").expect("mood")
    });
    let (rating, many) = statements(&data, &index, || {
        note_properties::named(&data, &index, "rating").expect("rating")
    });
    let mut mood = mood;
    mood.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(
        mood,
        [
            NoteWithProperty {
                id: "j2026-11-05".into(),
                title: "2026-11-05".into(),
                path: "journal/2026-11-05.md".into(),
                emoji: None,
                mismatch: false,
            },
            NoteWithProperty {
                id: "n0".into(),
                title: "Note 0".into(),
                path: "Note 0.md".into(),
                emoji: Some("🌱".into()),
                mismatch: true,
            },
        ]
    );
    assert_eq!(rating.len(), MANY);
    assert_eq!(few, many, "a read per note");
    assert!(many <= 2, "took {many} statements");
}
