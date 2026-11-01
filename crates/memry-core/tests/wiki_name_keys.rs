//! `wiki_name_keys` (data migration 0019) only narrows the rows a wiki name lookup reads:
//! whatever wrote the names, and whether or not the reindex has settled their keys since, a
//! lookup answers as a load of the whole vault does. Each trigger arm of the migration is
//! here as the write it follows, made after a settle so only the trigger can make it seen.

#![cfg(feature = "markdown")]

use memry_core::domain::note_meta::journal_date_of;
use memry_core::domain::wiki_target::{WikiNames, settle_name_keys};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS};
use proptest::prelude::*;
use rusqlite::{Connection, params};

fn db() -> Connection {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    data
}

fn run(data: &Connection, sql: &str) {
    data.execute_batch(sql).expect(sql);
}

fn note(data: &Connection, id: &str, title: &str, folder: Option<&str>, file_type: &str) {
    data.execute(
        "INSERT INTO notes (id, title, folder_path, file_type, created_at, modified_at) \
         VALUES (?1, ?2, ?3, ?4, 1, 1)",
        params![id, title, folder, file_type],
    )
    .expect("note");
}

fn aliases(data: &Connection, id: &str, aliases: &str) {
    data.execute(
        "UPDATE notes SET aliases = ?2 WHERE id = ?1",
        params![id, aliases],
    )
    .expect("aliases");
}

fn day(data: &Connection, date: &str) {
    data.execute(
        "INSERT INTO journal_entries (id, date, created_at, modified_at) VALUES (?1, ?2, 1, 1)",
        params![format!("j{date}"), date],
    )
    .expect("day");
}

/// A day's aliases as the journal projector writes them (`projectors/notes.rs`).
fn day_aliases(data: &Connection, id: &str, aliases: &str) {
    data.execute(
        "INSERT INTO journal_aliases (journal_id, aliases) VALUES (?1, ?2)
         ON CONFLICT(journal_id) DO UPDATE SET aliases = excluded.aliases",
        params![id, aliases],
    )
    .expect("day aliases");
}

/// `Err` naming the first target that resolves otherwise through the keys than through the
/// whole vault. Each target is looked up alone and in the batch: a batch reads the rows of
/// every target's keys, so a row a trigger missed can still be read for another target, such
/// as its old name.
fn same_answers(data: &Connection, targets: &[&str]) -> Result<(), String> {
    let batch = WikiNames::load_for(data, targets.iter().copied()).map_err(|e| e.to_string())?;
    for target in targets {
        let alone = WikiNames::load_for(data, [*target]).map_err(|e| e.to_string())?;
        same_answer(data, &alone, target)?;
        same_answer(data, &batch, target)?;
    }
    Ok(())
}

fn same_answer(data: &Connection, narrow: &WikiNames, target: &str) -> Result<(), String> {
    let whole = WikiNames::load(data).map_err(|e| e.to_string())?;
    let (by_key, all) = (narrow.resolve_target(target), whole.resolve_target(target));
    if by_key != all {
        return Err(format!("{target:?}: by key {by_key:?}, whole {all:?}"));
    }
    let (by_key, all) = (narrow.resolve(target), whole.resolve(target));
    if by_key != all {
        return Err(format!(
            "{target:?} as a title: by key {by_key:?}, whole {all:?}"
        ));
    }
    if let Some((date, _)) = journal_date_of(target)
        && narrow.journal_on(&date) != whole.journal_on(&date)
    {
        return Err(format!("{target:?} as a day"));
    }
    Ok(())
}

fn stored_keys(data: &Connection) -> Vec<(String, String)> {
    let mut statement = data
        .prepare("SELECT key, id FROM wiki_name_keys ORDER BY key, id")
        .expect("keys");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("keys")
        .collect::<Result<_, _>>()
        .expect("keys")
}

const TARGETS: &[&str] = &[
    "Plan",
    "Strategy",
    "Work/Plan",
    "Archive/Strategy",
    "/diagram",
    "q3 goals",
    "h2 goals",
    "Roadmap",
    "Sprint #4",
    "Fresh",
    "kickoff",
    "launch",
    "retro",
    "2026-01-02",
    "2026-01-03",
    "2026-01-04",
    "j2026-01-04",
    "2026-01-05",
];

type Write = (&'static str, fn(&Connection));

/// The write each trigger arm follows, in an order where each changes what a target names.
const WRITES: &[Write] = &[
    ("note title", |d| {
        run(d, "UPDATE notes SET title = 'Strategy' WHERE id = 'n1'")
    }),
    ("note folder", |d| {
        run(
            d,
            "UPDATE notes SET folder_path = 'Archive' WHERE id = 'n1'",
        )
    }),
    ("note file type", |d| {
        run(d, "UPDATE notes SET file_type = 'markdown' WHERE id = 'n3'")
    }),
    ("note aliases", |d| aliases(d, "n2", r#"["H2 Goals"]"#)),
    ("note tombstone", |d| {
        run(d, "UPDATE notes SET deleted_at = 2 WHERE id = 'n2'")
    }),
    ("note undelete", |d| {
        run(d, "UPDATE notes SET deleted_at = NULL WHERE id = 'n2'")
    }),
    ("note id", |d| {
        run(d, "UPDATE notes SET id = 'n9' WHERE id = 'n4'")
    }),
    ("note insert", |d| note(d, "n5", "Fresh", None, "markdown")),
    ("day aliases update", |d| {
        day_aliases(d, "j2026-01-02", r#"["Launch"]"#)
    }),
    ("day insert", |d| day(d, "2026-01-03")),
    ("day aliases insert", |d| {
        day_aliases(d, "j2026-01-03", r#"["Retro"]"#)
    }),
    ("day date", |d| {
        run(
            d,
            "UPDATE journal_entries SET date = '2026-01-04' WHERE id = 'j2026-01-03'",
        )
    }),
    ("day tombstone", |d| {
        run(
            d,
            "UPDATE journal_entries SET deleted_at = 2 WHERE id = 'j2026-01-02'",
        )
    }),
    ("day undelete", |d| {
        run(
            d,
            "UPDATE journal_entries SET deleted_at = NULL WHERE id = 'j2026-01-02'",
        )
    }),
    ("day id", |d| {
        run(
            d,
            "UPDATE journal_entries SET id = 'jx' WHERE id = 'j2026-01-03'",
        )
    }),
    ("day aliases move", |d| {
        run(
            d,
            "UPDATE journal_aliases SET journal_id = 'j2026-01-05' WHERE journal_id = 'j2026-01-02'",
        )
    }),
    ("note delete", |d| {
        run(d, "DELETE FROM notes WHERE id = 'n9'")
    }),
    ("day delete", |d| {
        run(d, "DELETE FROM journal_entries WHERE id = 'jx'")
    }),
    ("day aliases delete", |d| {
        run(
            d,
            "DELETE FROM journal_aliases WHERE journal_id = 'j2026-01-05'",
        )
    }),
];

/// Each write a trigger arm follows, made after a settle, is seen before the next settle; and
/// once settled, the stored keys are the ones a settle from nothing stores.
#[test]
fn every_name_write_after_a_settle_is_seen() {
    let data = db();
    note(&data, "n1", "Plan", Some("Work"), "markdown");
    note(&data, "n2", "Roadmap", None, "markdown");
    aliases(&data, "n2", r#"["Q3 Goals"]"#);
    note(&data, "n3", "diagram", None, "image");
    note(&data, "n4", "Sprint #4", None, "markdown");
    day(&data, "2026-01-02");
    day_aliases(&data, "j2026-01-02", r#"["Kickoff"]"#);
    day(&data, "2026-01-05");
    for (name, write) in WRITES {
        settle_name_keys(&data).expect("settle");
        write(&data);
        if let Err(diff) = same_answers(&data, TARGETS) {
            panic!("after the {name} write: {diff}");
        }
        // Settled, the keys are those a settle from nothing stores: a row that went, or a
        // name it no longer has, keeps no key.
        settle_name_keys(&data).expect("settle");
        let settled = stored_keys(&data);
        run(
            &data,
            "DELETE FROM wiki_name_keys; \
             INSERT INTO wiki_names_owed (id) SELECT id FROM notes UNION SELECT id FROM journal_entries",
        );
        settle_name_keys(&data).expect("settle");
        assert_eq!(
            settled,
            stored_keys(&data),
            "keys the {name} write left behind"
        );
    }
}

/// A title is looked up as `resolve` reads it: JavaScript's trim keeps U+0085, which Rust's
/// `trim` drops, so a path spelled with it must still find its note.
#[test]
fn a_target_led_by_a_next_line_is_looked_up_as_written() {
    let data = db();
    note(&data, "n1", "Plan", Some("\u{85}Work"), "markdown");
    settle_name_keys(&data).expect("settle");
    let target = "\u{85}Work/Plan";
    let found = WikiNames::load_for(&data, [target])
        .expect("load")
        .resolve(target)
        .map(|found| found.id);
    assert_eq!(found.as_deref(), Some("n1"));
    assert_eq!(same_answers(&data, &[target]), Ok(()));
}

/// One row of a generated vault: a note or a day, possibly deleted.
#[derive(Debug, Clone)]
enum Item {
    Note {
        title: String,
        folder: Option<String>,
        markdown: bool,
        aliases: Vec<String>,
        deleted: bool,
    },
    Day {
        date: String,
        aliases: Vec<String>,
    },
}

/// A write after the vault is built and settled, on the note or day at a position.
#[derive(Debug, Clone)]
enum Op {
    Rename(usize, String),
    Move(usize, Option<String>),
    FileType(usize, bool),
    Aliases(usize, Vec<String>),
    Delete(usize, bool),
    DayAliases(usize, Vec<String>),
    DayDate(usize, String),
    DayDelete(usize, bool),
}

fn spelling() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("Plan".to_owned()),
        Just("plan".to_owned()),
        Just(" PLAN ".to_owned()),
        Just("\u{85}Plan".to_owned()),
        Just("Plan#4".to_owned()),
        Just("Ärger".to_owned()),
        Just("ärger".to_owned()),
        Just("2026-01-02".to_owned()),
        Just("x".to_owned()),
    ]
}

fn item() -> impl Strategy<Value = Item> {
    prop_oneof![
        3 => (
            spelling(),
            prop::option::of(prop_oneof![Just("Work".to_owned()), Just("work".to_owned())]),
            any::<bool>(),
            prop::collection::vec(spelling(), 0..2),
            any::<bool>(),
        )
            .prop_map(|(title, folder, markdown, aliases, deleted)| Item::Note {
                title,
                folder,
                markdown,
                aliases,
                deleted,
            }),
        1 => (
            prop_oneof![Just("2026-01-02".to_owned()), Just("2026-01-03".to_owned())],
            prop::collection::vec(spelling(), 0..2),
        )
            .prop_map(|(date, aliases)| Item::Day { date, aliases }),
    ]
}

fn op() -> impl Strategy<Value = Op> {
    let at = 0usize..12;
    let names = || prop::collection::vec(spelling(), 0..2);
    prop_oneof![
        (at.clone(), spelling()).prop_map(|(i, s)| Op::Rename(i, s)),
        (at.clone(), prop::option::of(Just("Work".to_owned()))).prop_map(|(i, f)| Op::Move(i, f)),
        (at.clone(), any::<bool>()).prop_map(|(i, m)| Op::FileType(i, m)),
        (at.clone(), names()).prop_map(|(i, a)| Op::Aliases(i, a)),
        (at.clone(), any::<bool>()).prop_map(|(i, d)| Op::Delete(i, d)),
        (at.clone(), names()).prop_map(|(i, a)| Op::DayAliases(i, a)),
        (
            at.clone(),
            prop_oneof![Just("2026-01-04".to_owned()), Just("2026-01-02".to_owned())]
        )
            .prop_map(|(i, d)| Op::DayDate(i, d)),
        (at, any::<bool>()).prop_map(|(i, d)| Op::DayDelete(i, d)),
    ]
}

fn target() -> impl Strategy<Value = String> {
    prop_oneof![
        spelling(),
        spelling().prop_map(|s| format!("Work/{s}")),
        spelling().prop_map(|s| format!("\u{85}Work/{s}")),
        spelling().prop_map(|s| format!("/work/{s}.md")),
        spelling().prop_map(|s| format!("{s}.png")),
        spelling().prop_map(|s| format!("{s}#Heading")),
        Just("j2026-01-03".to_owned()),
        Just("j2026-01-04".to_owned()),
    ]
}

fn json(names: &[String]) -> String {
    serde_json::to_string(names).expect("json")
}

/// The day at position `at` among the days, by id.
fn day_id(data: &Connection, at: usize) -> Option<String> {
    let mut statement = data
        .prepare("SELECT id FROM journal_entries ORDER BY id")
        .expect("days");
    let ids: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .expect("days")
        .collect::<Result<_, _>>()
        .expect("days");
    (!ids.is_empty()).then(|| ids[at % ids.len()].clone())
}

fn apply(data: &Connection, op: &Op) {
    let note_id = |at: &usize| format!("n{at:02}");
    let set = |sql: &str, id: String, value: &dyn rusqlite::ToSql| {
        data.execute(sql, params![id, value]).expect(sql);
    };
    match op {
        Op::Rename(at, title) => set(
            "UPDATE notes SET title = ?2 WHERE id = ?1",
            note_id(at),
            title,
        ),
        Op::Move(at, folder) => set(
            "UPDATE notes SET folder_path = ?2 WHERE id = ?1",
            note_id(at),
            folder,
        ),
        Op::FileType(at, markdown) => set(
            "UPDATE notes SET file_type = ?2 WHERE id = ?1",
            note_id(at),
            &if *markdown { "markdown" } else { "image" },
        ),
        Op::Aliases(at, names) => aliases(data, &note_id(at), &json(names)),
        Op::Delete(at, deleted) => set(
            "UPDATE notes SET deleted_at = ?2 WHERE id = ?1",
            note_id(at),
            &deleted.then_some(2),
        ),
        Op::DayAliases(at, names) => {
            if let Some(id) = day_id(data, *at) {
                day_aliases(data, &id, &json(names));
            }
        }
        Op::DayDate(at, date) => {
            // Dates are unique: a write onto another day's date is refused, and skipped.
            if let Some(id) = day_id(data, *at) {
                let _ = data.execute(
                    "UPDATE journal_entries SET date = ?2 WHERE id = ?1",
                    params![id, date],
                );
            }
        }
        Op::DayDelete(at, deleted) => {
            if let Some(id) = day_id(data, *at) {
                set(
                    "UPDATE journal_entries SET deleted_at = ?2 WHERE id = ?1",
                    id,
                    &deleted.then_some(2),
                );
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    /// Owed or settled, and after any writes since the settle, the answer is the one the
    /// whole vault gives, ties included.
    #[test]
    fn the_lookup_by_key_answers_as_the_whole_vault_does(
        items in prop::collection::vec(item(), 0..12),
        settle_after in 0usize..13,
        ops in prop::collection::vec(op(), 0..6),
        targets in prop::collection::vec(target(), 1..6),
    ) {
        let data = db();
        let mut days = std::collections::HashSet::new();
        for (at, item) in items.iter().enumerate() {
            if at == settle_after {
                settle_name_keys(&data).expect("settle");
            }
            match item {
                Item::Note { title, folder, markdown, aliases: names, deleted } => {
                    let id = format!("n{at:02}");
                    let kind = if *markdown { "markdown" } else { "image" };
                    note(&data, &id, title, folder.as_deref(), kind);
                    aliases(&data, &id, &json(names));
                    if *deleted {
                        apply(&data, &Op::Delete(at, true));
                    }
                }
                Item::Day { date, aliases: names } => {
                    if days.insert(date.clone()) {
                        day(&data, date);
                        day_aliases(&data, &format!("j{date}"), &json(names));
                    }
                }
            }
        }
        let targets: Vec<&str> = targets.iter().map(String::as_str).collect();
        prop_assert_eq!(same_answers(&data, &targets), Ok(()));
        // Every write below lands after a settle: only the triggers make it seen.
        settle_name_keys(&data).expect("settle");
        for op in &ops {
            apply(&data, op);
            prop_assert_eq!(same_answers(&data, &targets), Ok(()), "after {:?}", op);
        }
    }
}
