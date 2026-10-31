//! A real `data.db` and the reads the note identity tests make of it.

#![allow(dead_code, reason = "each test binary uses a part of it")]

use std::collections::HashMap;

use memry_core::api::errors::StorageError;
use memry_core::domain::external_feed::{self, FeedInput, FeedOutcome};
use memry_core::domain::note_files::{self, NoteFileStat};
use memry_core::domain::note_positions;
use memry_core::domain::notes::identity::{self, Adopted, FileNote};
use memry_core::domain::notes::{self, NewNote};
use memry_core::markdown::convert::EmbedResolver;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::Value;

pub const NOW: i64 = 1_760_000_000_000;
pub const DEVICE: &str = "device-a";
pub const BORN: i64 = 1_700_000_000_000;
pub const TOUCHED: i64 = 1_700_000_500_000;

pub fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-identity-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

pub fn run<T>(db: &Db, f: impl FnOnce(&mut Connection) -> Result<T, StorageError>) -> T {
    db.call_blocking(f).expect("a database call")
}

fn sql(conn: &Connection, statement: &str, values: impl rusqlite::Params) {
    conn.execute(statement, values).expect("a statement");
}

/// A markdown file at `path` whose body is `body`.
pub fn file(path: &'static str, body: &'static str) -> FileNote<'static> {
    let (folder_path, name) = match path.rsplit_once('/') {
        Some((folder, name)) => (Some(folder), name),
        None => (None, path),
    };
    FileNote {
        path,
        title: name.strip_suffix(".md").expect("a markdown path"),
        folder_path,
        body,
        created_ms: BORN,
        modified_ms: TOUCHED,
        electron_db_beside: false,
    }
}

pub fn adopt(db: &Db, file: FileNote<'_>, new_id: &str) -> Adopted {
    adopt_with(db, file, new_id, None)
}

/// [`adopt`], with the vault's image embeds.
pub fn adopt_with(
    db: &Db,
    file: FileNote<'_>,
    new_id: &str,
    embeds: Option<&dyn EmbedResolver>,
) -> Adopted {
    let converter = Converter::new(CalloutTypes::new(Vec::new()));
    db.call_blocking(|conn| {
        Ok(identity::adopt(
            conn,
            Some(&converter),
            embeds,
            &file,
            new_id,
            DEVICE,
            NOW,
        ))
    })
    .expect("a database call")
    .expect("an answer")
}

pub fn create(db: &Db, id: &str, title: &str, folder: Option<&str>) {
    let note = NewNote {
        id,
        title,
        folder_path: folder,
        content: "",
        tags: &[],
        properties: None,
        emoji: None,
    };
    run(db, |conn| notes::create(conn, &note, DEVICE, NOW).map(drop));
}

/// Gives the note a body, as a file's text fed into it.
pub fn give_body(db: &Db, id: &str, path: &str, markdown: &str) {
    give_body_at(db, id, path, markdown, NOW);
}

/// [`give_body`], stamped `at`.
pub fn give_body_at(db: &Db, id: &str, path: &str, markdown: &str, at: i64) {
    feed(db, id, path, markdown, at, None);
}

/// [`give_body`], the file's image embeds resolved by `embeds`.
pub fn give_body_with(db: &Db, id: &str, path: &str, markdown: &str, embeds: &dyn EmbedResolver) {
    feed(db, id, path, markdown, NOW, Some(embeds));
}

/// Image embeds (`![[target]]`) found at the URLs given, by target.
pub struct Embeds(pub HashMap<String, String>);

impl EmbedResolver for Embeds {
    fn resolve(&self, target: &str, _note_path: Option<&str>) -> Option<String> {
        self.0.get(target).cloned()
    }
}

fn feed(
    db: &Db,
    id: &str,
    path: &str,
    markdown: &str,
    at: i64,
    embeds: Option<&dyn EmbedResolver>,
) {
    let converter = Converter::new(CalloutTypes::new(Vec::new()));
    let input = FeedInput {
        note_id: id,
        markdown,
        note_path: Some(path),
        writing: None,
        frontmatter: None,
        embeds,
    };
    let outcome = db
        .call_blocking(|conn| {
            Ok(external_feed::feed_external_edit(
                conn, &converter, input, DEVICE, at,
            ))
        })
        .expect("a database call")
        .expect("a feed");
    assert_eq!(outcome, FeedOutcome::Fed);
}

/// A note another device pushed, applied as a pull applies it.
pub fn pulled(db: &Db, id: &str, payload: &Value) {
    pulled_item(db, "note", id, payload);
}

pub fn pulled_item(db: &Db, item_type: &str, id: &str, payload: &Value) {
    let inbound = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    run(db, |conn| {
        sync_items::apply_remote(conn, &inbound, NOW).map(drop)
    });
}

/// A row whose hash is of the file's text, as the tier records one the note's document took.
pub fn give_row(db: &Db, id: &str, path: &str) {
    give_row_hashes(db, id, path, Some("hash"), Some("hash"));
}

/// A row naming the text the document holds (`content`) and the bytes on disk (`file`).
pub fn give_row_hashes(db: &Db, id: &str, path: &str, content: Option<&str>, file: Option<&str>) {
    let stat = NoteFileStat {
        note_id: id.to_owned(),
        path: path.to_owned(),
        file_type: "markdown".to_owned(),
        mime_type: None,
        file_size: Some(1),
        content_hash: content.map(str::to_owned),
        file_hash: file.map(str::to_owned),
        indexed_at: NOW,
    };
    run(db, |conn| note_files::upsert_stat(conn, &stat));
}

pub fn set_meta(db: &Db, key: &str, value: &str) {
    run(db, |conn| {
        sql(
            conn,
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        );
        Ok(())
    });
}

pub fn clear_outbox(db: &Db) {
    run(db, |conn| {
        sql(conn, "DELETE FROM outbox", []);
        Ok(())
    });
}

/// `(op, item_id)` of every queued row, in order.
pub fn outbox(db: &Db) -> Vec<(String, String)> {
    run(db, |conn| {
        let mut statement = conn
            .prepare("SELECT op, item_id FROM outbox ORDER BY id")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query");
        Ok(rows.map(|row| row.expect("a row")).collect())
    })
}

pub fn payload(db: &Db, id: &str) -> Value {
    run(db, |conn| {
        let raw = sync_items::push_payload(conn, "note", id)?.expect("a payload");
        Ok(serde_json::from_str(&raw).expect("valid JSON"))
    })
}

pub fn note_count(db: &Db) -> i64 {
    run(db, |conn| {
        Ok(conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .expect("count"))
    })
}

pub fn deleted(db: &Db, id: &str) -> bool {
    run(db, |conn| {
        Ok(conn
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .expect("the note"))
    })
}

pub fn position(db: &Db, path: &str) -> Option<(String, i64)> {
    run(db, |conn| {
        Ok(conn
            .query_row(
                "SELECT folder_path, position FROM note_positions WHERE path = ?1",
                params![path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .expect("read"))
    })
}

pub fn place(db: &Db, folder: &str, paths: &[&str]) {
    let paths: Vec<String> = paths.iter().map(|path| (*path).to_owned()).collect();
    run(db, |conn| note_positions::reorder(conn, folder, &paths));
}
