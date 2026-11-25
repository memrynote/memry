//! Records refused only because their signer was not in the pass's device
//! directory (chapter 01 §1.4.0, #5413).
//!
//! The directory is fetched once, at the start of a pass. A device that
//! registers and writes during the pass signs records this one cannot verify:
//! each is stored corrupt and the feed cursor moves past it, so the feed never
//! serves it again. A refused delete then leaves the row live here, and for a
//! clockless type (settings, a delete stored with no clock) the server accepts
//! a later edit of it and the item comes back on every device.
//!
//! - [`refused`] records the refusal as one `meta` row per `(type, id)`,
//!   which a local edit never touches (an edit clears `corrupt_reason`, so the
//!   reason cannot be the record of it).
//! - [`retry`] re-pulls those ids at the start of every pass, over that pass's
//!   fresh directory, until a budget below runs out. The desktop driver
//!   (`driver/refusals.rs`) asks [`any_waiting`] first and refetches the
//!   directory for it; a failed refetch counts through [`directory_failed`].
//! - [`holds`] keeps a queued edit of such a row out of the push meanwhile
//!   ([`held`] is the push gate's form of it).
//! - The wait ends when the row resolves: a verified record for it
//!   ([`resolve_verified`]) drops the `meta` row and the row's flag; the last
//!   retry keeps the `meta` row as given up, with the flag.
//!
//! Only a well-formed answer that leaves the id out counts toward
//! [`MAX_RETRIES`]: anything else would give up on a record over a server
//! hiccup (#5502). The server's unusable answer about the request (a record
//! still unverifiable, a coded 4xx kept as [`ApiError::Status`]) counts toward
//! [`MAX_FAILURES`], which still bounds the hold. Nothing else counts: transport,
//! 5xx, 429, a 200 that is no pull envelope, a 4xx with no code (a portal's), a
//! 4xx that arrives as its own [`ApiError`] variant (any 401, a revoked device,
//! a 402 vault limit, a 403 with writes disabled, a 409 device limit, a 426
//! upgrade-required): it is about the session, device or plan, not the record.
//!
//! The settings item reuses the hold (#5433): an edit over a deleted
//! payload-less settings row ([`crate::domain::settings::apply`]) records a
//! refusal of `synced_settings`, so the server copy is re-pulled and merged
//! before the edit pushes. A settings hold is re-pulled on its own, so another
//! record's answer never counts toward releasing a seeded one-key edit over
//! live server settings.
//!
//! A record whose signature fails for any other reason is never retried: its
//! reason does not end with
//! [`crate::protocol::account::UNKNOWN_SIGNER`].
//!
//! The rows are baseline `meta` rows, so no numbered migration is needed:
//! `sync.unknown_signer_wait:{type}:{id}` holding the passes that re-pulled
//! it. An older build never reads them. Every pass adopts a flag with no
//! `meta` row, which is a refusal an older build recorded only in
//! `corrupt_reason`, also one it recorded after a downgrade. A reason an
//! earlier feat build ended with ` (no longer re-pulled)` (#5429) no longer
//! ends with the flag, so that given-up row is not adopted again.

use rusqlite::{Connection, params};

use crate::api::errors::{ApiError, StorageError};
use crate::domain::settings::SETTINGS_ITEM_TYPE;
use crate::storage::Db;
use crate::storage::repositories::sync_items;

use super::apply::Pending;
use super::first_sync_store::{read_meta, write_meta};
use super::outbox::{self, OutboxRow};
use super::pull::{PullError, PullLoop, PullReport};

/// Well-formed re-pulls that left the record out before its hold gives up:
/// the server no longer serves it. The row stays as it is, and its `meta` row
/// stays at this count, given up.
pub(crate) const MAX_RETRIES: u32 = 5;

/// Re-pulls the server refused (a coded 4xx kept as [`ApiError::Status`]) or
/// answered unverifiable before a hold gives up. Stored after a `/` in the
/// `meta` value; an older build parses such a value as 0 and keeps holding.
pub(crate) const MAX_FAILURES: u32 = 50;

const KEY_PREFIX: &str = "sync.unknown_signer_wait:";
/// The first key past every [`KEY_PREFIX`] key (`;` follows `:`).
const KEY_END: &str = "sync.unknown_signer_wait;";
/// Id-only keys of unreleased builds (#5426, and feat's #5429), moved once by
/// [`migrate_id_only_keys`]. A local edit clears the row's flag, so such a key
/// can be the only record of a hold.
const OLD_KEYS: (&str, &str) = (
    "sync.unknown_signer_retries:",
    "sync.unknown_signer_retries;",
);
const OLD_SEEDED_KEY: &str = "sync.unknown_signer_seeded";
/// Set once the id-only keys are moved (sorts outside [`KEY_PREFIX`]).
const MIGRATED_KEY: &str = "sync.unknown_signer_wait_keyed";

/// Item types hold no `:`, so the first one ends the type.
fn key(item_type: &str, item_id: &str) -> String {
    format!("{KEY_PREFIX}{item_type}:{item_id}")
}

/// Records a fresh refusal of the item's record: a full retry budget.
pub(crate) fn refused(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<(), StorageError> {
    write_meta(conn, &key(item_type, item_id), "0")
}

/// Ends the wait on every item in `pending`: each arrived verified, applied
/// or skipped, so its signer is known and nothing is left to re-pull.
pub(crate) fn resolve_verified(conn: &Connection, pending: &[Pending]) -> Result<(), StorageError> {
    if pending.is_empty() || recorded(conn)?.is_empty() {
        return Ok(());
    }
    for item in pending {
        drop_refusal(conn, item.item_type(), item.item_id())?;
        sync_items::clear_unknown_signer(conn, item.item_type(), item.item_id())?;
    }
    Ok(())
}

/// Whether a queued edit of this row waits: its last pulled record was
/// refused for an unknown signer and is still being re-pulled. Sending the
/// edit could reverse a delete this device has not verified yet.
pub(crate) fn holds(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<bool, StorageError> {
    Ok(read_meta(conn, &key(item_type, item_id))?.is_some_and(|value| waiting(&value)))
}

/// Why a queued row waits instead of being sent: an upsert of a row
/// [`holds`] keeps. `None` sends it.
pub(crate) async fn held(db: &Db, row: &OutboxRow) -> Result<Option<String>, StorageError> {
    if row.op != outbox::OP_UPSERT {
        return Ok(None);
    }
    let (item_type, item_id) = (row.item_type.clone(), row.item_id.clone());
    let held = db
        .call(move |conn| holds(conn, &item_type, &item_id))
        .await?;
    Ok(held.then(|| "held: its last pulled record waits on an unknown signer".to_owned()))
}

/// Whether any refusal waits, after the same migration and adoption as
/// [`retry`], so a refusal an older build recorded is seen on this pass.
pub(crate) fn any_waiting(conn: &Connection) -> Result<bool, StorageError> {
    Ok(!waiting_holds(conn)?.is_empty())
}

/// Re-pulls, by id, every refusal still waiting. The caller built `pull` over
/// the directory it fetched for this pass. Each settings hold is re-pulled on
/// its own, every other hold in one batch; each outcome counts per
/// [`counted`].
pub(crate) async fn retry(db: &Db, pull: &PullLoop) -> Result<(), StorageError> {
    let (settings, due): (Vec<_>, Vec<_>) = db
        .call(|conn| waiting_holds(conn))
        .await?
        .into_iter()
        .partition(|(item_type, _, _)| item_type == SETTINGS_ITEM_TYPE);
    for hold in settings {
        re_pull(db, pull, vec![hold]).await?;
    }
    if !due.is_empty() {
        re_pull(db, pull, due).await?;
    }
    Ok(())
}

/// A directory refetch for the re-pull failed. It counts as a failed re-pull
/// would ([`counted_error`]), and a malformed directory counts too: one failure toward [`MAX_FAILURES`] for every
/// waiting hold, or nothing for the network or the server's health. So a
/// directory that never loads cannot hold an edit for ever, and a server
/// hiccup never ends a hold (#5502).
pub(crate) async fn directory_failed(db: &Db, error: &ApiError) -> Result<(), StorageError> {
    // A garbled directory counts too, unlike a re-pull's non-envelope answer
    // (#5651): a directory that never loads must not hold an edit for ever.
    let counted = match error {
        ApiError::MalformedResponse { .. } => Counted::Failure,
        other => counted_error(other),
    };
    if matches!(counted, Counted::Nothing) {
        return Ok(());
    }
    db.call(move |conn| {
        let holds = waiting_holds(conn)?;
        count(conn, holds, counted)
    })
    .await
}

/// What one re-pull counts toward (VERIFY-5447 r3).
enum Counted {
    /// Says nothing about the server copy, or about this request.
    Nothing,
    /// A well-formed answer that left the id out: the server holds no copy.
    Attempt,
    /// An answer about this request that cannot be used, which may persist.
    Failure,
}

/// Classifies a re-pull. Only a page that decoded, held no unverifiable
/// record and left an id out shows the server has no copy; a record that
/// resolved its hold has already dropped its `meta` row. A captive portal or
/// proxy answers a 200 that is no pull envelope (a page, `{}`) or a 4xx with
/// no error code (403, 407): off the server's network, these count nothing,
/// or they would release a hold (VERIFY-5447 r4 #8).
fn counted(result: &Result<PullReport, PullError>) -> Counted {
    match result {
        Ok(report) if report.corrupt > 0 || report.refused => Counted::Failure,
        Ok(report) if report.dropped_pages > 0 => Counted::Nothing,
        Ok(report) if report.uncovered > 0 => Counted::Attempt,
        Ok(_) => Counted::Failure,
        Err(PullError::Api { source }) => counted_error(source),
        Err(_) => Counted::Nothing,
    }
}

/// A malformed body or a 4xx other than 429 is about the request; anything
/// else (transport, 5xx, 429, a local failure) says nothing.
fn counted_error(error: &ApiError) -> Counted {
    match error {
        ApiError::Status {
            status,
            code: Some(_),
            ..
        } if (400..500).contains(status) && *status != 429 => Counted::Failure,
        _ => Counted::Nothing,
    }
}

/// Re-pulls `holds` in one fetch and counts its outcome (see [`counted`])
/// against every one still recorded after it.
async fn re_pull(
    db: &Db,
    pull: &PullLoop,
    holds: Vec<(String, String, String)>,
) -> Result<(), StorageError> {
    let mut ids: Vec<String> = holds.iter().map(|(_, id, _)| id.clone()).collect();
    ids.sort();
    ids.dedup();
    let result = pull.fetch_ids(&ids).await;
    match &result {
        Err(error) => eprintln!(
            "memry-core: re-pulling {} record(s) of an unknown signer failed: {error}",
            ids.len()
        ),
        Ok(report) if report.dropped_pages > 0 => eprintln!(
            "memry-core: re-pulling {} record(s) of an unknown signer got {} answer(s) \
             that were no pull envelope",
            ids.len(),
            report.dropped_pages
        ),
        Ok(_) => {}
    }
    let counted = counted(&result);
    if matches!(counted, Counted::Nothing) {
        return Ok(());
    }
    db.call(move |conn| count(conn, holds, counted)).await
}

/// Counts `counted` against every one of `holds` still recorded: an attempt
/// toward [`MAX_RETRIES`], a failure toward [`MAX_FAILURES`]. A refusal
/// recorded again since `holds` was read counts against the budget it had
/// before.
fn count(
    conn: &Connection,
    holds: Vec<(String, String, String)>,
    counted: Counted,
) -> Result<(), StorageError> {
    for (item_type, id, value) in holds {
        let key = key(&item_type, &id);
        if read_meta(conn, &key)?.is_none() {
            continue;
        }
        let (mut attempts, mut failures) = (attempts_of(&value), failures_of(&value));
        match counted {
            Counted::Attempt => attempts += 1,
            _ => failures += 1,
        }
        if attempts >= MAX_RETRIES || failures >= MAX_FAILURES {
            eprintln!(
                "memry-core: {item_type} {id}: {attempts} re-pull(s) found no server copy \
                 and {failures} failed; no longer re-pulled"
            );
        }
        write_meta(conn, &key, &format!("{attempts}/{failures}"))?;
    }
    Ok(())
}

/// Whether a recorded value still holds: under both budgets.
fn waiting(value: &str) -> bool {
    attempts_of(value) < MAX_RETRIES && failures_of(value) < MAX_FAILURES
}

fn attempts_of(value: &str) -> u32 {
    value
        .split('/')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

fn failures_of(value: &str) -> u32 {
    value
        .split_once('/')
        .and_then(|(_, n)| n.parse().ok())
        .unwrap_or(0)
}

/// Moves the id-only keys once, adopts the unrecorded flags, then reads every
/// refusal still waiting, as `(type, id, value)`.
fn waiting_holds(conn: &Connection) -> Result<Vec<(String, String, String)>, StorageError> {
    migrate_id_only_keys(conn)?;
    adopt(conn)?;
    Ok(recorded(conn)?
        .into_iter()
        .filter(|(_, _, value)| waiting(value))
        .collect())
}

/// Every recorded refusal, waiting or given up, as `(type, id, value)`.
fn recorded(conn: &Connection) -> Result<Vec<(String, String, String)>, StorageError> {
    let mut statement = conn
        .prepare("SELECT key, value FROM meta WHERE key >= ?1 AND key < ?2 ORDER BY key")
        .map_err(failed)?;
    let rows = statement
        .query_map(params![KEY_PREFIX, KEY_END], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(rows
        .into_iter()
        .filter_map(|(key, value)| {
            let (item_type, id) = key[KEY_PREFIX.len()..].split_once(':')?;
            Some((item_type.to_owned(), id.to_owned(), value))
        })
        .collect())
}

fn drop_refusal(conn: &Connection, item_type: &str, item_id: &str) -> Result<(), StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [key(item_type, item_id)])
        .map_err(failed)?;
    Ok(())
}

/// Moves each id-only key to every row with that id, at the same count:
/// holding a sibling of another type a few passes is harmless, dropping a
/// hold can push an edit over an unverified delete (REVIEW-5448). Runs once.
fn migrate_id_only_keys(conn: &Connection) -> Result<(), StorageError> {
    if read_meta(conn, MIGRATED_KEY)?.is_some() {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value)
         SELECT ?1 || s.item_type || ':' || s.item_id, m.value
         FROM meta m JOIN sync_items s ON s.item_id = substr(m.key, length(?2) + 1)
         WHERE m.key >= ?2 AND m.key < ?3",
        params![KEY_PREFIX, OLD_KEYS.0, OLD_KEYS.1],
    )
    .map_err(failed)?;
    conn.execute(
        "DELETE FROM meta WHERE (key >= ?1 AND key < ?2) OR key = ?3",
        params![OLD_KEYS.0, OLD_KEYS.1, OLD_SEEDED_KEY],
    )
    .map_err(failed)?;
    write_meta(conn, MIGRATED_KEY, "1")
}

/// Adopts every flagged row with no `meta` row: a refusal an older build
/// recorded only in `corrupt_reason`, before or after this build first ran.
/// A row this build resolved has no flag, and one it gave up on keeps its
/// `meta` row, so neither comes back.
fn adopt(conn: &Connection) -> Result<(), StorageError> {
    for (item_type, id) in sync_items::unknown_signer_rows(conn)? {
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, '0')",
            [key(&item_type, &id)],
        )
        .map_err(failed)?;
    }
    Ok(())
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
