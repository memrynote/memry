//! Link reads on a 20,000-note vault cost a fixed number of SQL statements, the same for a
//! note with one backlink, mention or title to resolve as for one with hundreds (#3530 13i).
//! Counted in statements on both databases, not milliseconds, so the bound holds on any
//! machine (as `calendar_week_load.rs` counts them): a read per backlink, per mention source
//! or per resolved title would grow the count with the list.

use std::sync::atomic::{AtomicUsize, Ordering};

use memry_core::api::search::BacklinkOrder;
use memry_core::domain::journal_ops::links;
use memry_core::domain::link_reads;
use memry_core::domain::unlinked_mentions::unlinked_mentions;
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use rusqlite::trace::TraceEventCodes;
use rusqlite::{Connection, params};

const NOTES: usize = 20_000;
const MANY: usize = 400;

static STATEMENTS: AtomicUsize = AtomicUsize::new(0);

/// A statement the code ran. SQLite reports the statements a virtual table runs for it too,
/// prefixed `-- ` (FTS5 reads each matched row's text from its content table); those are
/// row reads of the one query, not statements of ours.
fn count(event: rusqlite::trace::TraceEvent<'_>) {
    if let rusqlite::trace::TraceEvent::Stmt(_, sql) = event
        && !sql.starts_with("-- ")
    {
        STATEMENTS.fetch_add(1, Ordering::SeqCst);
    }
}

/// `n{i}` titled `Note {i}` with a file at `F{i % 50}/Note {i}.md`. `few` (`n1`) is linked
/// to by `n2` and mentioned by `n3` only, `many` (`n0`) linked to and mentioned by `MANY`
/// notes each.
fn vault() -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    let tx = data.transaction().expect("tx");
    for i in 0..NOTES {
        let (id, title) = (format!("n{i}"), format!("Note {i}"));
        tx.execute(
            "INSERT INTO notes (id, title, folder_path, file_type, created_at, modified_at) \
             VALUES (?1, ?2, ?3, 'markdown', ?4, ?4)",
            params![id, title, format!("F{}", i % 50), i as i64],
        )
        .expect("note");
        tx.execute(
            "INSERT INTO note_files (note_id, path, file_type, indexed_at) \
             VALUES (?1, ?2, 'markdown', 0)",
            params![id, format!("F{}/{title}.md", i % 50)],
        )
        .expect("file row");
    }
    tx.commit().expect("commit");
    let tx = index.transaction().expect("tx");
    let link = |source: usize, target: usize| {
        tx.execute(
            "INSERT INTO note_links (source_id, target_id, target_title) VALUES (?1, ?2, ?3)",
            params![
                format!("n{source}"),
                format!("n{target}"),
                format!("Note {target}")
            ],
        )
        .expect("link");
    };
    link(2, 1);
    for source in 10..10 + MANY {
        link(source, 0);
    }
    let text = |id: usize, content: &str| {
        tx.execute(
            "INSERT INTO fts_notes (id, title, content, tags) VALUES (?1, ?2, ?3, '')",
            params![format!("n{id}"), format!("Note {id}"), content],
        )
        .expect("fts row");
    };
    text(3, "about note 1 here");
    // A backlink and the note itself are not unlinked mentions.
    text(2, "about note 1 here");
    text(1, "note 1 itself");
    for id in 1000..1000 + MANY {
        text(id, "about note 0 here");
    }
    tx.commit().expect("commit");
    (data, index)
}

/// Statements `read` runs on both connections.
fn statements<T>(data: &Connection, index: &Connection, read: impl FnOnce() -> T) -> (T, usize) {
    STATEMENTS.store(0, Ordering::SeqCst);
    data.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(count));
    index.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(count));
    let out = read();
    data.trace_v2(TraceEventCodes::empty(), None);
    index.trace_v2(TraceEventCodes::empty(), None);
    (out, STATEMENTS.load(Ordering::SeqCst))
}

#[test]
fn link_reads_cost_the_same_statements_for_one_link_or_hundreds() {
    let (data, index) = vault();

    let (few, few_cost) = statements(&data, &index, || {
        link_reads::incoming(&data, &index, "n1")
            .expect("incoming")
            .sources
    });
    let (many, many_cost) = statements(&data, &index, || {
        link_reads::incoming(&data, &index, "n0")
            .expect("incoming")
            .sources
    });
    assert_eq!((few.len(), many.len()), (1, MANY));
    assert_eq!(few[0].source_path.as_deref(), Some("F2/Note 2.md"));
    let named = link_reads::incoming(&data, &index, "n1").expect("incoming");
    assert_eq!(named.target_title.as_deref(), Some("Note 1"));
    assert_eq!(few_cost, many_cost, "incoming: one read per backlink");
    assert!(many_cost <= 4, "incoming took {many_cost} statements");

    let (few, few_cost) = statements(&data, &index, || {
        links::backlinks(&data, &index, "n1", BacklinkOrder::Title).expect("backlinks")
    });
    let (many, many_cost) = statements(&data, &index, || {
        links::backlinks(&data, &index, "n0", BacklinkOrder::Title).expect("backlinks")
    });
    assert_eq!((few.len(), many.len()), (1, MANY));
    assert_eq!(few_cost, many_cost, "backlinks: one read per backlink");

    let one = vec!["Note 7".to_owned()];
    let lots: Vec<String> = (0..MANY).map(|i| format!("note {}", i * 37)).collect();
    let (found, one_cost) = statements(&data, &index, || {
        link_reads::resolve_titles(&data, &one).expect("resolve")
    });
    assert_eq!(found[0].as_ref().map(|t| t.id.as_str()), Some("n7"));
    let (found, lots_cost) = statements(&data, &index, || {
        link_reads::resolve_titles(&data, &lots).expect("resolve")
    });
    assert!(found.iter().all(Option::is_some));
    assert_eq!(
        found[1].as_ref().map(|t| t.path.as_deref()),
        Some(Some("F37/Note 37.md"))
    );
    assert_eq!(one_cost, lots_cost, "resolve_titles: one read per title");

    let (few, few_cost) = statements(&data, &index, || {
        unlinked_mentions(&data, &index, "n1").expect("mentions")
    });
    let (many, many_cost) = statements(&data, &index, || {
        unlinked_mentions(&data, &index, "n0").expect("mentions")
    });
    assert_eq!((few.len(), many.len()), (1, MANY));
    assert_eq!(
        few_cost, many_cost,
        "unlinked mentions: one read per source"
    );

    let sources = |id: &str| {
        link_reads::mention_sources(&data, &index, id)
            .expect("mention sources")
            .expect("live")
            .sources
    };
    let (few, few_cost) = statements(&data, &index, || sources("n1"));
    let (many, many_cost) = statements(&data, &index, || sources("n0"));
    assert_eq!((few.len(), many.len()), (1, MANY));
    assert_eq!(few[0].source_path.as_deref(), Some("F3/Note 3.md"));
    assert_eq!(few_cost, many_cost, "mention sources: one read per source");
}
