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
use memry_core::domain::wiki_target::settle_name_keys;
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use rusqlite::trace::TraceEventCodes;
use rusqlite::{Connection, params};

const NOTES: usize = 20_000;
const MANY: usize = 400;

static STATEMENTS: AtomicUsize = AtomicUsize::new(0);
static VM_STEPS: AtomicUsize = AtomicUsize::new(0);

/// A statement the code ran. SQLite reports the statements a virtual table runs for it too,
/// prefixed `-- ` (FTS5 reads each matched row's text from its content table); those are
/// row reads of the one query, not statements of ours.
fn count(event: rusqlite::trace::TraceEvent<'_>) {
    match event {
        rusqlite::trace::TraceEvent::Stmt(_, sql) if !sql.starts_with("-- ") => {
            STATEMENTS.fetch_add(1, Ordering::SeqCst);
        }
        // The virtual machine steps a finished statement took: rows scanned and sought, not
        // only returned, so a filtered scan of the whole vault shows as one.
        rusqlite::trace::TraceEvent::Profile(statement, _) => {
            let steps = statement.get_status(rusqlite::StatementStatus::VmStep);
            VM_STEPS.fetch_add(usize::try_from(steps).unwrap_or(0), Ordering::SeqCst);
        }
        _ => {}
    }
}

/// `notes` notes, `n{i}` titled `Note {i}` with a file at `F{i % 50}/Note {i}.md`, their
/// wiki name keys settled as a reindex settles them. `few` (`n1`) is linked
/// to and mentioned by `n2` only, `many` (`n0`) by `MANY` notes.
fn vault(notes: usize) -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    let tx = data.transaction().expect("tx");
    for i in 0..notes {
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
    for id in 1000..1000 + MANY {
        text(id, "about note 0 here");
    }
    tx.commit().expect("commit");
    settle_name_keys(&data).expect("settle");
    (data, index)
}

/// The virtual machine steps `read` takes on `data`.
fn vm_steps<T>(data: &Connection, read: impl FnOnce() -> T) -> (T, usize) {
    VM_STEPS.store(0, Ordering::SeqCst);
    data.trace_v2(TraceEventCodes::SQLITE_TRACE_PROFILE, Some(count));
    let out = read();
    data.trace_v2(TraceEventCodes::empty(), None);
    (out, VM_STEPS.load(Ordering::SeqCst))
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
    let (data, index) = vault(NOTES);

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
}

/// A title, a target and a note's outgoing links read only the rows that hold their names:
/// the same virtual machine steps on a vault of 200 notes as on one of 20,000. Steps, not
/// statements: loading every name is two statements too.
#[test]
fn a_name_lookup_reads_as_much_in_a_large_vault_as_in_a_small_one() {
    let lookups = |data: &Connection, index: &Connection| {
        let (titles, title_steps) = vm_steps(data, || {
            link_reads::resolve_titles(data, &["note 7".to_owned()]).expect("resolve")
        });
        assert_eq!(titles[0].as_ref().map(|t| t.id.as_str()), Some("n7"));
        let (target, target_steps) = vm_steps(data, || {
            link_reads::resolve_target(data, "F7/Note 7#Goals").expect("resolve")
        });
        assert_eq!(
            target.map(|(t, h)| (t.id, h)),
            Some(("n7".to_owned(), Some("Goals".to_owned())))
        );
        let (outgoing, outgoing_steps) = vm_steps(data, || {
            links::outgoing_links(data, index, "n2").expect("outgoing")
        });
        assert_eq!(outgoing[0].target_id.as_deref(), Some("n1"));
        (title_steps, target_steps, outgoing_steps)
    };
    let (small_data, small_index) = vault(200);
    let (data, index) = vault(NOTES);
    let small = lookups(&small_data, &small_index);
    let large = lookups(&data, &index);
    assert_eq!(small, large, "a lookup reads more of a larger vault");

    // The measure sees a whole read: owed rows are read whole, as the vault's are here.
    data.execute("INSERT INTO wiki_names_owed (id) SELECT id FROM notes", [])
        .expect("owe every row");
    let (_, owed_steps) = vm_steps(&data, || {
        link_reads::resolve_titles(&data, &["note 7".to_owned()]).expect("resolve")
    });
    assert!(
        owed_steps > 100 * large.0,
        "{owed_steps} steps against {}",
        large.0
    );
}
