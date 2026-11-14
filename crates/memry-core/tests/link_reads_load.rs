//! Link reads on a 20,000-note vault cost a fixed number of SQL statements, the same for a
//! note with one backlink, mention or title to resolve as for one with hundreds (#3530 13i).
//! Counted in statements on both databases, not milliseconds, so the bound holds on any
//! machine (as `calendar_week_load.rs` counts them): a read per backlink, per mention source
//! or per resolved title would grow the count with the list.

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use memry_core::api::search::BacklinkOrder;
use memry_core::domain::journal_ops::links;
use memry_core::domain::link_reads;
#[cfg(feature = "markdown")]
use memry_core::domain::tag_reads;
use memry_core::domain::unlinked_mentions::unlinked_mentions;
use memry_core::domain::wiki_target::settle_name_keys;
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use rusqlite::trace::TraceEventCodes;
use rusqlite::{Connection, params};

const NOTES: usize = 20_000;
const MANY: usize = 400;

static STATEMENTS: AtomicUsize = AtomicUsize::new(0);
static VM_STEPS: AtomicUsize = AtomicUsize::new(0);
/// Held by each test that counts `VM_STEPS`: the tests of a binary run in parallel.
static STEPPING: Mutex<()> = Mutex::new(());

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
/// wiki name keys settled as a reindex settles them. `few` (`n1`) is linked to by `n2` and
/// mentioned by `n3` only, `many` (`n0`) linked to and mentioned by `MANY` notes each.
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
    // A backlink and the note itself are not unlinked mentions.
    text(2, "about note 1 here");
    text(1, "note 1 itself");
    for id in 1000..1000 + MANY {
        text(id, "about note 0 here");
    }
    // Every note relates to the next one, as the note index writes a relation; `n5` also names
    // the journal day `2026-05-08`, which has no entry.
    let relate = |id: usize, uris: &[String]| {
        tx.execute(
            "INSERT INTO note_properties (note_id, name, value, type) \
             VALUES (?1, 'related', ?2, 'relation')",
            params![format!("n{id}"), serde_json::to_string(uris).expect("uris")],
        )
        .expect("property row");
        for uri in uris {
            let (kind, target) = uri["memry://".len()..].split_once('/').expect("a relation");
            tx.execute(
                "INSERT INTO property_refs (source_id, name, target_type, target_id) \
                 VALUES (?1, 'related', ?2, ?3)",
                params![format!("n{id}"), kind, target],
            )
            .expect("relation row");
        }
    };
    for id in 0..notes {
        let mut uris = vec![format!("memry://note/n{}", id + 1)];
        if id == 5 {
            uris.push("memry://journal/2026-05-08".to_owned());
        }
        relate(id, &uris);
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

/// The virtual machine steps `read` takes on both connections.
fn vm_steps_both<T>(data: &Connection, index: &Connection, read: impl FnOnce() -> T) -> (T, usize) {
    VM_STEPS.store(0, Ordering::SeqCst);
    data.trace_v2(TraceEventCodes::SQLITE_TRACE_PROFILE, Some(count));
    index.trace_v2(TraceEventCodes::SQLITE_TRACE_PROFILE, Some(count));
    let out = read();
    data.trace_v2(TraceEventCodes::empty(), None);
    index.trace_v2(TraceEventCodes::empty(), None);
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

/// A title, a target and a note's outgoing links read only the rows that hold their names:
/// the same virtual machine steps on a vault of 200 notes as on one of 20,000. Steps, not
/// statements: loading every name is two statements too.
#[test]
fn a_name_lookup_reads_as_much_in_a_large_vault_as_in_a_small_one() {
    let _stepping = STEPPING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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

/// A journal day not written yet lists its links and the relations naming it by seeking them:
/// the same virtual machine steps on a vault of 200 notes, each with a relation, as on one of
/// 20,000.
#[test]
fn an_unwritten_days_references_read_as_much_in_a_large_vault_as_in_a_small_one() {
    let _stepping = STEPPING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let day = |data: &Connection, index: &Connection| {
        let (incoming, steps) = vm_steps_both(data, index, || {
            link_reads::incoming(data, index, "j2026-05-08").expect("incoming")
        });
        let sources: Vec<(String, Option<String>)> = incoming
            .sources
            .into_iter()
            .map(|s| (s.source_id, s.via_property))
            .collect();
        assert_eq!(sources, [("n5".to_owned(), Some("related".to_owned()))]);
        steps
    };
    let (small_data, small_index) = vault(200);
    let (data, index) = vault(NOTES);
    let (small, large) = (day(&small_data, &small_index), day(&data, &index));
    assert_eq!(
        small, large,
        "a day's references read more of a larger vault"
    );
}

/// The tags the reference filters read for a list's sources: the same statements for one source
/// as for hundreds, and the same virtual machine steps on a vault of 200 notes, each tagged in
/// its record, its body and its header, as on one of 20,000.
#[cfg(feature = "markdown")]
#[test]
fn reference_source_tags_read_by_key_whatever_the_list_or_the_vault() {
    let _stepping = STEPPING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let tag_every_note = |data: &Connection, index: &Connection, notes: usize| {
        data.execute_batch(
            "INSERT INTO note_tags (note_id, tag, position) SELECT id, 'work', 0 FROM notes; \
             INSERT INTO note_body_tags (note_id, tag) SELECT id, 'inline' FROM notes;",
        )
        .expect("record and body tags");
        index
            .execute(
                "INSERT INTO note_stats (note_id, file_hash, word_count, character_count, \
                 snippet, task_ids, header_tags, indexed_at) \
                 SELECT 'n' || i, NULL, 1, 1, '', '[]', '[\"Work\",\"header\"]', 0 \
                 FROM (WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n \
                 WHERE i + 1 < ?1) SELECT i FROM n)",
                params![notes as i64],
            )
            .expect("header tags");
    };
    let (small_data, small_index) = vault(200);
    let (data, index) = vault(NOTES);
    tag_every_note(&small_data, &small_index, 200);
    tag_every_note(&data, &index, NOTES);

    let read = |data: &Connection, index: &Connection, ids: &[String]| {
        vm_steps_both(data, index, || tags_of(data, index, ids))
    };
    let one = vec!["n7".to_owned()];
    let (small_tags, small_steps) = read(&small_data, &small_index, &one);
    let (tags, steps) = read(&data, &index, &one);
    // The header's spelling of a tag the record holds is the same tag; the record's is kept.
    assert_eq!(tags["n7"], ["work", "inline", "header"]);
    assert_eq!(small_tags, tags);
    assert_eq!(
        small_steps, steps,
        "a source's tags read more of a larger vault"
    );

    let lots: Vec<String> = (10..10 + MANY).map(|i| format!("n{i}")).collect();
    let (_, one_cost) = statements(&data, &index, || tags_of(&data, &index, &one));
    let (found, lots_cost) = statements(&data, &index, || tags_of(&data, &index, &lots));
    assert_eq!(found.len(), MANY);
    assert_eq!(one_cost, lots_cost, "tags: one read per source");
}

#[cfg(feature = "markdown")]
fn tags_of(
    data: &Connection,
    index: &Connection,
    ids: &[String],
) -> std::collections::HashMap<String, Vec<String>> {
    tag_reads::of_notes(data, index, ids.iter().map(String::as_str)).expect("tags")
}
