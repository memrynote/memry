//! Stage 36b3: notes, journal days, their `note_files` rows, the manual order and the snapshots.
//!
//! The `ELECTRON_*` payloads are the output of Electron's push builders (`origin/main` f5fd229,
//! `buildNotePushPayload` and the journal handler's `buildPushPayload`) run in node over these
//! same fixtures, with Electron's own `parseNote`, `extractAliases`, `parseJournalEntry`,
//! `extractJournalProperties`, `noteCoverFromFrontmatter` and `deserializeValue`. The import
//! must store them byte for byte, apart from the departures each test names.

use std::collections::BTreeMap;
use std::path::Path;

use memry_core::storage::import::DATA_FILE;
use rusqlite::Connection;
use rusqlite::types::Value;
use sha2::{Digest, Sha256};

use super::{Vault, electron_db, import};

const PLAN: &str = "-0QKFMSbJ-18";
const IDEA: &str = "NvXCU8_x4cv9";
const PDF: &str = "V1StGXR8_Z5jdHi6B-myT";
const GONE: &str = "G0ne-missing";
const DAY: &str = "j2026-01-05";
const BAD_YAML: &str = "Bad-yaml0001";
const NUM_TAGS: &str = "Num-tags0001";
const BIG: &str = "Big-file0001";
const NUM_ALIASES: &str = "Num-alias001";

const PLAN_FILE: &str = "---\ntags: [a, b]\naliases: [Alt, Plan]\ncover: wash:sage\nstatus: draft\n---\n# Plan\n\nBody \u{2028} \"quoted\" \u{e9}\n";
const IDEA_FILE: &str = "Just a thought \u{2028} \"q\" \u{e9}\r\n";
const DAY_FILE: &str = "---\ntags: daily\nmood: good\naliases: x\n---\n\nToday.\n\n";

const ELECTRON_PLAN: &str = "{\"title\":\"Plan\",\"content\":null,\"tags\":[\"a\",\"b\"],\"aliases\":[\"Alt\"],\"properties\":{\"status\":\"draft\",\"count\":3},\"pinnedTags\":[\"a\"],\"emoji\":\"\u{1f5c2}\",\"fileType\":\"markdown\",\"folderPath\":\"Projects\",\"cover\":{\"ref\":\"wash:sage\"},\"clock\":{\"dev-A\":3,\"dev-B\":1},\"createdAt\":\"2026-01-02T03:04:05.000Z\",\"modifiedAt\":\"2026-01-03T03:04:05.000Z\"}";
const ELECTRON_IDEA: &str = "{\"title\":\"Idea\",\"content\":\"Just a thought \u{2028} \\\"q\\\" \u{e9}\\r\\n\",\"tags\":[],\"aliases\":[],\"properties\":{},\"pinnedTags\":[],\"emoji\":null,\"fileType\":\"markdown\",\"folderPath\":null,\"attachmentReferences\":[\"att-1\"],\"clock\":{},\"createdAt\":\"2026-01-02T03:04:05.000Z\",\"modifiedAt\":\"2026-01-03T03:04:05.000Z\"}";
/// Electron builds no payload for a local-only row; this is the binary branch's output.
const ELECTRON_PDF: &str = "{\"title\":\"doc\",\"emoji\":null,\"fileType\":\"pdf\",\"mimeType\":\"application/pdf\",\"attachmentId\":\"att-pdf\",\"folderPath\":\"Files\",\"clock\":{},\"createdAt\":\"2026-01-02T03:04:05.000Z\",\"modifiedAt\":\"2026-01-03T03:04:05.000Z\"}";
const ELECTRON_GONE: &str = "{\"title\":\"Gone\",\"content\":null,\"tags\":[],\"properties\":{},\"pinnedTags\":[],\"emoji\":null,\"fileType\":\"markdown\",\"folderPath\":null,\"clock\":{\"dev-A\":2},\"createdAt\":\"2026-01-02T03:04:05.000Z\",\"modifiedAt\":\"2026-01-03T03:04:05.000Z\"}";
/// A clocked day with no queued `create` is pushed as an update: no body.
const ELECTRON_DAY: &str = "{\"date\":\"2026-01-05\",\"content\":null,\"tags\":[\"daily\"],\"properties\":{\"mood\":\"good\",\"aliases\":\"x\"},\"aliases\":[],\"clock\":{\"dev-A\":5},\"createdAt\":\"2026-01-05T08:00:00.000Z\",\"modifiedAt\":\"2026-01-05T09:00:00.000Z\"}";
const ELECTRON_BAD_YAML: &str = "{\"title\":\"Bad\",\"content\":\"Body\\n\",\"tags\":[],\"aliases\":[],\"properties\":{},\"pinnedTags\":[],\"emoji\":null,\"fileType\":\"markdown\",\"folderPath\":null,\"clock\":{},\"createdAt\":\"2026-01-02T03:04:05.000Z\",\"modifiedAt\":\"2026-01-03T03:04:05.000Z\"}";
const ELECTRON_NUM_TAGS: &str = "{\"title\":\"Num\",\"content\":null,\"tags\":[2024,\"x\"],\"aliases\":[],\"properties\":{},\"pinnedTags\":[],\"emoji\":null,\"fileType\":\"markdown\",\"folderPath\":null,\"clock\":{\"dev-A\":1},\"createdAt\":\"2026-01-02T03:04:05.000Z\",\"modifiedAt\":\"2026-01-03T03:04:05.000Z\"}";
const ELECTRON_NUM_ALIASES: &str = "{\"title\":\"Alias\",\"content\":null,\"tags\":[],\"aliases\":[\"Infinity\",\"12345678901234567000\"],\"properties\":{},\"pinnedTags\":[],\"emoji\":null,\"fileType\":\"markdown\",\"folderPath\":null,\"clock\":{\"dev-A\":1},\"createdAt\":\"2026-01-02T03:04:05.000Z\",\"modifiedAt\":\"2026-01-03T03:04:05.000Z\"}";

/// V8's `String::kMaxLength` in UTF-16 units, the import's byte cap.
const MAX_FILE_BYTES: u64 = (1 << 29) - 24;

/// `(note_id, path, local_only, content_hash)` of a `note_files` row.
type FileRow = (String, String, bool, Option<String>);
/// A `note_snapshots` row in column order.
type SnapshotRow = (String, String, String, String, i64, String, String, String);

struct Note<'a> {
    id: &'a str,
    path: &'a str,
    title: &'a str,
    file_type: &'a str,
    clock: Option<&'a str>,
    synced: bool,
}

fn note<'a>(id: &'a str, path: &'a str, title: &'a str, clock: Option<&'a str>) -> Note<'a> {
    Note {
        id,
        path,
        title,
        file_type: "markdown",
        clock,
        synced: true,
    }
}

fn text(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |v| Value::Text(v.into()))
}

fn seed_note(conn: &Connection, note: &Note<'_>, extra: &[(&str, Value)]) {
    let (created, modified) = match note.id {
        DAY => ("2026-01-05T08:00:00.000Z", "2026-01-05T09:00:00.000Z"),
        _ => ("2026-01-02T03:04:05.000Z", "2026-01-03T03:04:05.000Z"),
    };
    let mut values = vec![
        ("id", Value::Text(note.id.into())),
        ("path", Value::Text(note.path.into())),
        ("title", Value::Text(note.title.into())),
        ("file_type", Value::Text(note.file_type.into())),
        ("local_only", Value::Integer(0)),
        ("clock", text(note.clock)),
        (
            "synced_at",
            text(note.synced.then_some("2026-01-04T00:00:00.000Z")),
        ),
        ("created_at", Value::Text(created.into())),
        ("modified_at", Value::Text(modified.into())),
    ];
    for (name, value) in extra {
        values.retain(|(held, _)| held != name);
        values.push((name, value.clone()));
    }
    electron_db::seed(conn, "note_metadata", &values);
}

fn write_file(vault: &Vault, rel: &str, contents: &str) {
    let path = vault.root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// sha256 of every vault file outside `.memry/`, by relative path.
fn vault_files(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.ends_with(".memry") {
                continue;
            }
            if path.is_dir() {
                dirs.push(path);
            } else {
                let rel = path.strip_prefix(root).unwrap().display().to_string();
                out.insert(
                    rel,
                    hex::encode(Sha256::digest(std::fs::read(&path).unwrap())),
                );
            }
        }
    }
    out
}

fn installed(vault: &Vault) -> Connection {
    Connection::open(vault.core().join(DATA_FILE)).unwrap()
}

fn payload(core: &Connection, item_type: &str, id: &str) -> String {
    core.query_row(
        "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
        [item_type, id],
        |row| row.get(0),
    )
    .unwrap_or_else(|e| panic!("{item_type}/{id}: {e}"))
}

#[test]
fn notes_and_journal_days_import_as_electron_pushes_them() {
    let vault = Vault::new();
    let data = vault.data_conn();
    seed_note(
        &data,
        &note(
            PLAN,
            "Projects/Plan.md",
            "Plan",
            Some(r#"{"dev-A":3,"dev-B":1}"#),
        ),
        &[("emoji", Value::Text("\u{1f5c2}".into()))],
    );
    seed_note(
        &data,
        &Note {
            synced: false,
            ..note(IDEA, "Idea.md", "Idea", None)
        },
        &[("attachment_references", Value::Text(r#"["att-1"]"#.into()))],
    );
    seed_note(
        &data,
        &Note {
            file_type: "pdf",
            synced: false,
            ..note(PDF, "Files/doc.pdf", "doc", None)
        },
        &[
            ("mime_type", Value::Text("application/pdf".into())),
            ("file_size", Value::Integer(1234)),
            ("attachment_id", Value::Text("att-pdf".into())),
            ("local_only", Value::Integer(1)),
        ],
    );
    seed_note(
        &data,
        &note(GONE, "Gone.md", "Gone", Some(r#"{"dev-A":2}"#)),
        &[],
    );
    seed_note(
        &data,
        &Note {
            synced: false,
            ..note(
                DAY,
                "journal/2026-01-05.md",
                "2026-01-05",
                Some(r#"{"dev-A":5}"#),
            )
        },
        &[("journal_date", Value::Text("2026-01-05".into()))],
    );
    electron_db::seed(
        &data,
        "note_positions",
        &[
            ("path", Value::Text("Projects/Plan.md".into())),
            ("folder_path", Value::Text("Projects".into())),
            ("position", Value::Integer(2)),
        ],
    );
    drop(data);

    let index = Connection::open(&vault.pair.index).unwrap();
    // The index rows reference `note_cache` (rebuilt, not imported); `ghost-note` has no
    // `note_metadata` row, so its snapshot is an orphan to the import.
    for id in [PLAN, "ghost-note"] {
        electron_db::seed(&index, "note_cache", &[("id", Value::Text(id.into()))]);
    }
    // Rowid order (status, count) is not the primary key's order (count, status).
    for (name, value, kind) in [("status", "draft", "select"), ("count", "3", "number")] {
        electron_db::seed(
            &index,
            "note_properties",
            &[
                ("note_id", Value::Text(PLAN.into())),
                ("name", Value::Text(name.into())),
                ("value", Value::Text(value.into())),
                ("type", Value::Text(kind.into())),
            ],
        );
    }
    for (tag, pinned_at) in [("a", Some("2026-01-06T07:08:09.000Z")), ("b", None)] {
        electron_db::seed(
            &index,
            "note_tags",
            &[
                ("note_id", Value::Text(PLAN.into())),
                ("tag", Value::Text(tag.into())),
                ("pinned_at", text(pinned_at)),
            ],
        );
    }
    for (id, note_id) in [("snap-1", PLAN), ("snap-2", "ghost-note")] {
        electron_db::seed(
            &index,
            "note_snapshots",
            &[
                ("id", Value::Text(id.into())),
                ("note_id", Value::Text(note_id.into())),
                ("content", Value::Text("old body".into())),
                ("title", Value::Text("Plan".into())),
                ("word_count", Value::Integer(2)),
                ("content_hash", Value::Text("h1".into())),
                ("reason", Value::Text("manual".into())),
                ("created_at", Value::Text("2026-01-03 00:00:00".into())),
            ],
        );
    }
    drop(index);

    write_file(&vault, "Projects/Plan.md", PLAN_FILE);
    write_file(&vault, "Idea.md", IDEA_FILE);
    write_file(&vault, "journal/2026-01-05.md", DAY_FILE);
    let files_before = vault_files(&vault.root);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert_eq!(report.tables["data.db/note_metadata"].target_count, 5);
    assert_eq!(report.tables["data.db/note_positions"].target_count, 1);
    assert_eq!(report.tables["index.db/note_snapshots"].target_count, 1);
    assert_eq!(report.tables["index.db/note_snapshots"].dropped, 1);
    assert_eq!(report.dropped.get("snapshotsWithoutNote"), Some(&1));
    // The missing file is carried over with Electron's unread payload, and counted.
    assert_eq!(report.notices.get("unreadNoteFiles"), Some(&1));
    assert_eq!(
        vault_files(&vault.root),
        files_before,
        "vault files untouched"
    );

    let core = installed(&vault);
    assert_eq!(payload(&core, "note", PLAN), ELECTRON_PLAN);
    // An unclocked row: Electron's seed mints its first clock and queues a `create`, so the
    // body rides along.
    assert_eq!(
        payload(&core, "note", IDEA),
        ELECTRON_IDEA.replace(r#""clock":{}"#, r#""clock":{"device-electron":1}"#)
    );
    assert_eq!(payload(&core, "note", GONE), ELECTRON_GONE);
    assert_eq!(payload(&core, "journal", DAY), ELECTRON_DAY);
    // Departure 1: an unclocked row stores no `clock` key where Electron writes `{}`.
    assert_eq!(
        payload(&core, "note", PDF),
        ELECTRON_PDF.replace(r#""clock":{},"#, "")
    );
    let clock: Option<String> = core
        .query_row(
            "SELECT clock FROM sync_items WHERE item_id = ?1",
            [PDF],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(clock, None);

    let folder: Option<String> = core
        .query_row(
            "SELECT folder_path FROM notes WHERE id = ?1",
            [PLAN],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(folder.as_deref(), Some("Projects"));
    let pins: Vec<(String, Option<i64>)> = core
        .prepare("SELECT tag, pinned_at FROM note_tags WHERE note_id = ?1 ORDER BY tag")
        .unwrap()
        .query_map([PLAN], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        pins,
        vec![("a".into(), Some(1_767_683_289_000)), ("b".into(), None)]
    );

    let files: Vec<FileRow> = core
        .prepare("SELECT note_id, path, local_only, content_hash FROM note_files ORDER BY note_id")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let expected: Vec<FileRow> = [
        (PLAN, "Projects/Plan.md", false),
        (GONE, "Gone.md", false),
        (IDEA, "Idea.md", false),
        (PDF, "Files/doc.pdf", true),
        (DAY, "journal/2026-01-05.md", false),
    ]
    .into_iter()
    .map(|(id, path, local)| (id.to_owned(), path.to_owned(), local, None))
    .collect::<std::collections::BTreeSet<_>>()
    .into_iter()
    .collect();
    assert_eq!(files, expected);
    let hashes: i64 = core
        .query_row("SELECT count(*) FROM note_file_hashes", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(hashes, 0);

    let position: (String, String, i64) = core
        .query_row(
            "SELECT path, folder_path, position FROM note_positions",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(position, ("Projects/Plan.md".into(), "Projects".into(), 2));
    let snapshots: Vec<SnapshotRow> = core
        .prepare(
            "SELECT id, note_id, content, title, word_count, content_hash, reason, created_at \
             FROM note_snapshots",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        snapshots,
        vec![(
            "snap-1".into(),
            PLAN.into(),
            "old body".into(),
            "Plan".into(),
            2,
            "h1".into(),
            "manual".into(),
            "2026-01-03 00:00:00".into()
        )]
    );
}

/// The file guards: a frontmatter that does not parse keeps the body (`parseNote`), a tag list
/// with a non-string item keeps its strings (departure 2), and a file longer than V8 can hold
/// takes Electron's unread path without the read allocating it.
#[test]
fn hostile_note_files_take_electrons_paths() {
    let vault = Vault::new();
    let data = vault.data_conn();
    seed_note(
        &data,
        &Note {
            synced: false,
            ..note(BAD_YAML, "Bad.md", "Bad", None)
        },
        &[],
    );
    seed_note(
        &data,
        &note(NUM_TAGS, "Num.md", "Num", Some(r#"{"dev-A":1}"#)),
        &[],
    );
    seed_note(
        &data,
        &note(BIG, "Big.md", "Big", Some(r#"{"dev-A":2}"#)),
        &[],
    );
    seed_note(
        &data,
        &note(NUM_ALIASES, "Alias.md", "Alias", Some(r#"{"dev-A":1}"#)),
        &[],
    );
    drop(data);
    write_file(&vault, "Bad.md", "---\ntags: [a\n---\nBody\n");
    write_file(&vault, "Num.md", "---\ntags: [2024, x]\n---\n");
    write_file(
        &vault,
        "Alias.md",
        "---\naliases: [.inf, 12345678901234567890]\n---\n",
    );
    // A sparse file one byte past the cap: read whole, it would carry `tags: [a]`.
    write_file(&vault, "Big.md", "---\ntags: [a]\n---\n");
    std::fs::OpenOptions::new()
        .write(true)
        .open(vault.root.join("Big.md"))
        .unwrap()
        .set_len(MAX_FILE_BYTES + 1)
        .unwrap();

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert_eq!(
        report.notices.get("unreadNoteFiles"),
        Some(&1),
        "only Big.md"
    );
    let core = installed(&vault);
    assert_eq!(
        payload(&core, "note", BAD_YAML),
        ELECTRON_BAD_YAML.replace(r#""clock":{}"#, r#""clock":{"device-electron":1}"#)
    );
    // `extractAliases` prints a number with `String(n)`.
    assert_eq!(payload(&core, "note", NUM_ALIASES), ELECTRON_NUM_ALIASES);
    // Departure 2: the core reads `tags` as strings only, so the list keeps its strings.
    assert_eq!(
        payload(&core, "note", NUM_TAGS),
        ELECTRON_NUM_TAGS.replace("[2024,\"x\"]", "[\"x\"]")
    );
    // Electron's read throws past V8's string limit and its push takes the unread path,
    // the payload shape of a missing file.
    assert_eq!(
        payload(&core, "note", BIG),
        ELECTRON_GONE.replace("\"Gone\"", "\"Big\"")
    );
}
