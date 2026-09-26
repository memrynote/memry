//! The journal: one entry per calendar day (T128, FR-054, chapter 07 §7.1,
//! chapter 13 §13.7.2, data-model §A.4).
//!
//! **A journal body is a collaborative document in the same CRDT feed as a
//! note, and its document id is the journal record's own id** (§7.1, T035).
//! Two rules come straight out of that sentence and both are enforced here:
//!
//! - desktop mints `j<YYYY-MM-DD>` for a day it creates, but **an existing
//!   record's id wins**. A client MUST NOT derive the document id from the
//!   date when a record exists, so [`open_day`] looks the day up first and
//!   only [`document_id_for`] the day when there is nothing to find.
//! - the wire carries no item type for a body at all, so nothing here or in
//!   [`crate::crdt`] branches on whether a document id looks like a note's or
//!   a day's.
//!
//! **The core does not decide what "today" is.** `now_ms` is an instant and a
//! journal day is a calendar date in the user's own time zone, which this tier
//! has no access to; deriving the day from the instant would silently file an
//! evening entry under tomorrow for half the planet. The caller supplies the
//! date string and the core validates it.
//!
//! One row per day is structural rather than checked: `journal_entries.date`
//! is `NOT NULL UNIQUE` (migration `0002`). A day whose entry was deleted is
//! therefore **revived** under its original id rather than re-created under a
//! new one — the unique date leaves no second row to create, and FR-054 still
//! requires today to be reachable in one interaction.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use crate::api::errors::StorageError;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

use super::notes::{failed, iso, object, require_payload, seed_body, valid_document_id};
use super::recreate::{recreate_clock, write_over_tombstone};

/// The `(type, _)` half of every key this module writes.
pub const ITEM_TYPE: &str = "journal";

/// The day a caller asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedDay {
    /// The journal record's id, **and** its CRDT document id (§7.1).
    pub id: String,
    pub date: String,
    /// Whether this call created the entry.
    pub created: bool,
    /// Whether this call cleared a tombstone on an entry that already existed.
    pub revived: bool,
}

/// `j<YYYY-MM-DD>`, the id desktop mints for a day it creates
/// (`apps/desktop/src/main/lib/id.ts:20`, quoted by §7.1).
///
/// **Only for a day with no record.** When a record exists its id wins, even
/// when it is not this shape.
pub fn document_id_for(date: &str) -> Result<String, StorageError> {
    let id = format!("j{}", valid_date(date)?);
    valid_document_id(&id)?;
    Ok(id)
}

/// The record id of the entry for `date`, and whether it is tombstoned.
pub fn entry_for(conn: &Connection, date: &str) -> Result<Option<(String, bool)>, StorageError> {
    let date = valid_date(date)?;
    conn.query_row(
        "SELECT id, deleted_at FROM journal_entries WHERE date = ?1",
        params![date],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?.is_some(),
            ))
        },
    )
    .optional()
    .map_err(failed)
}

/// The entry for `date`, created if there is none and revived if it was
/// deleted.
///
/// Writes nothing at all for a day that already has a live entry. Under spec
/// 005-journal D2 this runs on a day's **first write**, never on navigation:
/// browsing days must not create entries.
pub fn open_day(
    conn: &Connection,
    date: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<OpenedDay, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let opened = open_day_in(&tx, date, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(opened)
}

/// [`open_day`] inside a transaction the caller holds, so a day's creation and
/// its first write commit together or not at all (D2: a failed first edit must
/// not leave an empty entry behind). Enqueues the record upsert when it
/// creates or revives; a later record write in the same transaction
/// supersedes that row (`outbox::enqueue`), which is intended.
pub fn open_day_in(
    tx: &Connection,
    date: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<OpenedDay, StorageError> {
    let date = valid_date(date)?.to_owned();
    if tx.is_autocommit() {
        return Err(StorageError::Failed {
            what: "open_day_in needs the caller's transaction".to_owned(),
        });
    }

    if let Some((id, deleted)) = entry_for(tx, &date)? {
        if !deleted {
            return Ok(OpenedDay {
                id,
                date,
                created: false,
                revived: false,
            });
        }
        revive_in(tx, &id, device_id, now_ms)?;
        outbox::enqueue(tx, &outbox::Change::upsert(ITEM_TYPE, &id), now_ms)?;
        return Ok(OpenedDay {
            id,
            date,
            created: false,
            revived: true,
        });
    }

    let id = document_id_for(&date)?;
    create_in(tx, &id, &date, device_id, now_ms)?;
    outbox::enqueue(tx, &outbox::Change::upsert(ITEM_TYPE, &id), now_ms)?;
    Ok(OpenedDay {
        id,
        date,
        created: true,
        revived: false,
    })
}

/// The id of the **live** entry for `date`, or `None` when the day has no
/// entry or only a tombstoned one. The read every "does this day exist" check
/// goes through, so browsing and writing agree.
pub fn live_entry(conn: &Connection, date: &str) -> Result<Option<String>, StorageError> {
    Ok(entry_for(conn, date)?.and_then(|(id, deleted)| (!deleted).then_some(id)))
}

/// Whether this vault holds a live journal entry with this record id.
pub fn journal_exists(conn: &Connection, id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM journal_entries WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// The create half of [`open_day_in`].
///
/// `content` is `""` for the same reason a note's is (chapter 12 §12.2): the
/// body is a collaborative document and the Y.Doc is authoritative, so a
/// create record carries an empty body rather than markdown this tier would
/// have had to produce.
fn create_in(
    tx: &Connection,
    id: &str,
    date: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let at = iso(now_ms)?;
    let payload = object(json!({
        "date": date,
        "content": "",
        "createdAt": at,
        "modifiedAt": at,
    }));
    // A day seen only as a metadata-only tombstone is created over it (#2409).
    write_over_tombstone(tx, ITEM_TYPE, id, payload, device_id, now_ms)?;
    // A journal body is edited exactly as a note's is (FR-055), so it gets
    // the same materialised body row: empty text, no seed, derived from
    // the Yjs log the moment there is one.
    seed_body(tx, id, "", now_ms)
}

/// Clears the tombstone on an entry whose day is being opened again.
///
/// The date is `UNIQUE`, so there is no second row to create; reviving the
/// original id is the only way "open today" can succeed after today was
/// deleted. The revival is a re-create, so its clock ticks past every delete
/// clock this device knows for the id (#2409).
fn revive_in(tx: &Connection, id: &str, device_id: &str, now_ms: i64) -> Result<(), StorageError> {
    tx.execute(
        "UPDATE sync_items SET deleted_at = NULL, updated_at = ?3
         WHERE item_type = ?1 AND item_id = ?2",
        params![ITEM_TYPE, id, now_ms],
    )
    .map_err(failed)?;
    let stored = require_payload(tx, ITEM_TYPE, id)?;
    let changes = [
        (
            "clock",
            Change::Set(recreate_clock(
                tx,
                ITEM_TYPE,
                id,
                stored.object(),
                None,
                device_id,
            )?),
        ),
        ("modifiedAt", Change::set(iso(now_ms)?)),
    ];
    sync_items::apply_local_edit_in(tx, ITEM_TYPE, id, &changes, now_ms)?;
    Ok(())
}

/// `YYYY-MM-DD`, a real calendar day.
///
/// The month and day are range-checked against the actual month length: the
/// date is `NOT NULL UNIQUE` in the projection and travels on the wire, and a
/// day that does not exist is a row every other device has to make sense of.
pub fn valid_date(date: &str) -> Result<&str, StorageError> {
    let refuse = || StorageError::Failed {
        what: format!("`{date}` is not a YYYY-MM-DD calendar date"),
    };
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(refuse());
    }
    let digits = |from: usize, to: usize| -> Option<u32> {
        let part = date.get(from..to)?;
        part.bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let (Some(year), Some(month), Some(day)) = (digits(0, 4), digits(5, 7), digits(8, 10)) else {
        return Err(refuse());
    };
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return Err(refuse());
    }
    Ok(date)
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_minted_id_is_the_day_prefixed_and_is_a_legal_document_id() {
        assert_eq!(document_id_for("2026-04-16").unwrap(), "j2026-04-16");
        assert!(valid_document_id("j2026-04-16").is_ok());
    }

    #[test]
    fn a_date_that_is_not_a_calendar_day_is_refused() {
        assert!(valid_date("2026-04-16").is_ok());
        assert!(valid_date("2024-02-29").is_ok(), "2024 is a leap year");
        assert!(valid_date("2026-02-29").is_err());
        assert!(valid_date("1900-02-29").is_err(), "1900 is not a leap year");
        assert!(valid_date("2000-02-29").is_ok(), "2000 is");
        assert!(valid_date("2026-13-01").is_err());
        assert!(valid_date("2026-04-31").is_err());
        assert!(valid_date("2026-4-16").is_err());
        assert!(valid_date("2026-04-16T00:00:00Z").is_err());
        assert!(valid_date("").is_err());
    }
}
