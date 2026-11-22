//! `bench bootstrap --vault <id>`: a fresh-device bootstrap of one vault,
//! timed, for the bootstrap benchmark (`pnpm bench:bootstrap core`, #5223).
//!
//! It runs the shells' own path, not `pull`'s: [`VaultSync::first_sync`] (refs,
//! metadata, packs, the recent bodies), then the body step every later pass
//! runs ([`body_step::run`]) until no live document is owed a body. It never
//! pushes, so the vault on the server is only read.
//!
//! Cadence: by default the body passes run back to back, the engine's best
//! case. iOS runs a pass per `sync_now` trigger (foreground, screen loads,
//! realtime notices), so its passes are spaced by those events; `--pass-interval`
//! spaces the passes the same way. Every wait is marked `sleep`, so the
//! harness counts it as client pacing and not as idle network.
//!
//! Every line on stdout is one JSON mark with a wall-clock `atMs`, so the
//! harness can line the marks up with the requests its proxy recorded.
//!
//! `bench oracle-state` prints what this device holds in the shape the
//! zero-loss oracle reads (`tests/sync-harness/src/zero-loss-oracle`), so the
//! sync harness can run the oracle on a core bootstrap (#5232).

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use memry_core::api::crypto::derive_vault_key;
use memry_core::api::errors::{StorageError, SyncError};
use memry_core::api::sync::{SyncPhase, SyncProgress, SyncProgressListener};
use memry_core::api::vault::Vault;
use memry_core::protocol::account::{self, AccountCipher};
use memry_core::protocol::types::Declaration;
use memry_core::storage::Db;
use memry_core::sync::body_pull::BodyPull;
use memry_core::sync::{body_debt, body_step};
use rusqlite::{Connection, OptionalExtension as _};
use serde_json::{Value as Json, json};

use crate::cli::{Args, Command, UsageError, required, usage, value};
use crate::commands::{format_hex, open_body};
use crate::session::{Cli, CliError};

/// `bench <subcommand> …`, after the word `bench`.
pub fn parse(args: &mut Args) -> Result<Command, UsageError> {
    match args.next().as_deref() {
        Some("bootstrap") => {
            let vault = required(args, "--vault", "bench bootstrap")?;
            let (mut pass_interval_secs, mut resume) = (0, false);
            while let Some(flag) = args.next() {
                match flag.as_str() {
                    "--resume" => resume = true,
                    "--pass-interval" => {
                        pass_interval_secs = value(args, "--pass-interval")?
                            .parse()
                            .or_else(|_| usage("--pass-interval takes whole seconds"))?;
                    }
                    other => return usage(format!("unexpected argument `{other}`")),
                }
            }
            Ok(Command::BenchBootstrap {
                vault,
                pass_interval_secs,
                resume,
            })
        }
        Some("oracle-state") => Ok(Command::BenchOracleState {
            vault: required(args, "--vault", "bench oracle-state")?,
        }),
        _ => usage("bench needs a subcommand: bootstrap or oracle-state"),
    }
}

/// Body passes in a row that may settle nothing before the run gives up and
/// reports the bodies as not reached. A `429` ends a pass early, so a few idle
/// passes are the rate limiter, not a stall.
const MAX_IDLE_BODY_PASSES: u32 = 6;
/// The wait after a pass that settled nothing, so the next one does not spend
/// a rate-limit bucket that has not refilled.
const IDLE_PASS_WAIT: Duration = Duration::from_secs(5);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn mark(name: &str, fields: Json) {
    let mut line = json!({ "mark": name, "atMs": now_ms() });
    if let (Some(line), Json::Object(fields)) = (line.as_object_mut(), fields) {
        line.extend(fields);
    }
    println!("{line}");
}

/// Marks `records` when the records phase ends, as iOS's `the first sync is
/// pulling bodies` line does: every record pass is over (#5233).
#[derive(Default)]
struct Progress {
    /// The phase last seen, and the documents its last records tick held.
    state: Mutex<(Option<SyncPhase>, u64)>,
}

impl SyncProgressListener for Progress {
    fn progress(&self, progress: SyncProgress) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let (phase, documents) = &mut *state;
        if *phase == Some(progress.phase) {
            if progress.phase == SyncPhase::Records {
                *documents = progress.completed;
            }
            return;
        }
        if *phase == Some(SyncPhase::Records) {
            mark("records", json!({ "documents": *documents }));
        }
        mark("phase", json!({ "phase": format!("{:?}", progress.phase) }));
        *phase = Some(progress.phase);
        *documents = progress.completed;
    }
}

pub async fn bootstrap(
    cli: &Cli,
    vault: &str,
    pass_interval: Duration,
    resume: bool,
) -> Result<(), CliError> {
    // A fresh device: this profile's copy of the vault goes, the account and
    // device registration stay. `--resume` keeps the copy a killed run left.
    let dir = cli.vault_dir(vault);
    if dir.exists() && !resume {
        std::fs::remove_dir_all(&dir)?;
    }
    drop(cli.open_vault(vault)?);
    let opened = Vault::open(vault.to_string(), dir.to_string_lossy().into_owned())?;
    let session = Arc::new(cli.session()?);

    mark("start", json!({ "vault": vault }));
    let summary = opened
        .sync(Arc::clone(&session))
        .first_sync(Some(Arc::new(Progress::default())))
        .await
        .map_err(sync_failed)?;
    mark(
        "firstSync",
        json!({
            "metadataApplied": summary.metadata_applied,
            "recordPackEntries": summary.record_pack_entries,
            "reconcilePulled": summary.reconcile_pulled,
            "packBodiesSettled": summary.pack_bodies_settled,
            "bodiesOwed": summary.bodies_owed,
            "metadataCorrupt": summary.metadata_corrupt,
            "bodies": summary.bodies,
            "bodiesStopped": summary.bodies_stopped,
            "elevated": summary.elevated,
        }),
    );

    let db = cli.open_vault(vault)?;
    let body_pull = body_pull(cli, db.clone(), vault).await?;
    let mut idle = 0;
    loop {
        let owed = db.call(|conn| body_debt::owed(conn)).await?.len();
        if owed == 0 {
            mark("bodies", json!({}));
            break;
        }
        if idle >= MAX_IDLE_BODY_PASSES {
            mark("bodiesNotReached", json!({ "owed": owed }));
            break;
        }
        let pass = body_step::run(&db, &body_pull).await?;
        mark(
            "bodyPass",
            json!({ "owedBefore": owed, "documents": pass.documents, "requests": pass.requests }),
        );
        let wait = if pass.documents == 0 {
            idle += 1;
            IDLE_PASS_WAIT.max(pass_interval)
        } else {
            idle = 0;
            pass_interval
        };
        if !wait.is_zero() {
            mark("sleep", json!({ "ms": wait.as_millis() as u64 }));
            tokio::time::sleep(wait).await;
        }
    }

    let (live, without_body) = db.call(|conn| body_coverage(conn)).await?;
    let server_bodies = body_pull.server_body_ids().await?;
    mark(
        "end",
        json!({
            "liveDocuments": live,
            "withBody": live - without_body.len() as u64,
            // Null when the body manifest read stopped short.
            "missingBodies": server_bodies.map(|ids| missing_bodies(&without_body, &ids)),
        }),
    );
    Ok(())
}

async fn body_pull(cli: &Cli, db: Db, vault: &str) -> Result<BodyPull, CliError> {
    let vault_key = derive_vault_key(cli.master_key()?)?;
    let http = cli.http()?;
    let directory = account::device_directory(&http).await?;
    let cipher = Arc::new(AccountCipher::new(vault_key, directory));
    Ok(BodyPull::new(http, db, Declaration::subscribed(), cipher).with_vault(vault))
}

/// Live notes and journals, and the ids of those that hold no body state
/// locally.
fn body_coverage(conn: &Connection) -> Result<(u64, Vec<String>), StorageError> {
    let failed = |error: rusqlite::Error| StorageError::Failed {
        what: format!("counting local bodies: {error}"),
    };
    let live: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM sync_items i WHERE {LIVE_DOCUMENT}"),
            [],
            |row| row.get(0),
        )
        .map_err(failed)?;
    let mut statement = conn
        .prepare(&format!(
            "SELECT i.item_id FROM sync_items i WHERE {LIVE_DOCUMENT} \
               AND NOT EXISTS (SELECT 1 FROM yjs_snapshots WHERE doc_id = i.item_id) \
               AND NOT EXISTS (SELECT 1 FROM yjs_updates WHERE doc_id = i.item_id) \
             ORDER BY i.item_id"
        ))
        .map_err(failed)?;
    let without_body = statement
        .query_map([], |row| row.get(0))
        .and_then(Iterator::collect)
        .map_err(failed)?;
    Ok((live as u64, without_body))
}

const LIVE_DOCUMENT: &str = "i.item_type IN ('note', 'journal') AND i.deleted_at IS NULL \
     AND i.corrupt_reason IS NULL";

/// The documents with no local body that the server holds a body for. One the
/// server has no body for (an attachment note, a note never edited) is not
/// missing anything (#5232).
fn missing_bodies(without_body: &[String], server_bodies: &HashSet<String>) -> usize {
    without_body
        .iter()
        .filter(|doc_id| server_bodies.contains(*doc_id))
        .count()
}

/// The oracle's `LocalVaultState`, plus what its semantic check digests: each
/// live record's stored payload, each body's merged state vector and full
/// state update, and the documents still owed a body.
pub async fn oracle_state(cli: &Cli, vault: &str) -> Result<(), CliError> {
    let db = cli.open_vault(vault)?;
    let (records, payloads) = db.call(|conn| read_records(conn)).await?;
    let mut bodies = db.call(|conn| read_bodies(conn)).await?;
    let mut state_vectors = BTreeMap::new();
    let mut body_states = BTreeMap::new();
    for (doc_id, entry) in bodies.iter_mut() {
        let body = open_body(&db, doc_id)?;
        state_vectors.insert(doc_id.clone(), format_hex(&body.state_vector()?));
        body_states.insert(doc_id.clone(), format_hex(&body.encode_state()?));
        // #5351: an update whose parents never arrived stays pending and shows
        // nothing, while the sequence numbers still read as applied.
        entry["pending"] = json!(body.has_missing_updates()?);
    }
    let owed = db.call(|conn| body_debt::owed(conn)).await?;
    for doc_id in &owed {
        bodies.entry(doc_id.clone()).or_insert_with(empty_body);
    }
    println!(
        "{}",
        json!({
            "records": records,
            "bodies": bodies,
            "payloads": payloads,
            "stateVectors": state_vectors,
            "bodyStates": body_states,
            "owed": owed,
        })
    );
    Ok(())
}

type Records = (BTreeMap<String, Json>, BTreeMap<String, Json>);

/// Every record that is not corrupt: a corrupt row holds nothing the shell
/// can show, so the oracle counts it as missing.
fn read_records(conn: &Connection) -> Result<Records, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT item_id, item_type, clock, deleted_at IS NOT NULL, payload FROM sync_items \
             WHERE corrupt_reason IS NULL",
        )
        .map_err(storage)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(storage)?;
    let (mut records, mut payloads) = (BTreeMap::new(), BTreeMap::new());
    for row in rows {
        let (id, item_type, clock, deleted, payload) = row.map_err(storage)?;
        let clock = clock
            .and_then(|text| serde_json::from_str::<Json>(&text).ok())
            .unwrap_or_else(|| json!({}));
        if let (false, Some(payload)) = (deleted, payload) {
            payloads.insert(id.clone(), Json::String(payload));
        }
        records.insert(
            id,
            json!({ "type": item_type, "clock": clock, "deleted": deleted }),
        );
    }
    Ok((records, payloads))
}

/// Every document with body state or a body cursor: the baseline's revision,
/// the highest server sequence the device holds (its cursor, or the
/// baseline's), and whether it holds no Yjs state at all. `pending` is filled
/// in by [`oracle_state`], which replays each body.
fn read_bodies(conn: &Connection) -> Result<BTreeMap<String, Json>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT doc_id FROM yjs_snapshots UNION SELECT doc_id FROM yjs_updates \
             UNION SELECT substr(scope, 6) FROM sync_cursors WHERE scope LIKE 'crdt:%'",
        )
        .map_err(storage)?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage)?;
    let mut bodies = BTreeMap::new();
    for doc_id in ids {
        let snapshot: Option<(Option<String>, i64)> = conn
            .query_row(
                "SELECT server_revision, last_seq FROM yjs_snapshots WHERE doc_id = ?1",
                [&doc_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        let cursor: Option<String> = conn
            .query_row(
                "SELECT cursor FROM sync_cursors WHERE scope = 'crdt:' || ?1",
                [&doc_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?
            .flatten();
        let updates: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM yjs_updates WHERE doc_id = ?1",
                [&doc_id],
                |row| row.get(0),
            )
            .map_err(storage)?;
        let cursor = cursor
            .and_then(|text| text.parse::<i64>().ok())
            .unwrap_or(0);
        let baseline = snapshot.as_ref().map_or(0, |(_, last_seq)| *last_seq);
        bodies.insert(
            doc_id,
            json!({
                "snapshotRevision": snapshot.and_then(|(revision, _)| revision),
                "appliedThrough": cursor.max(baseline),
                "empty": baseline == 0 && updates == 0 && cursor == 0,
            }),
        );
    }
    Ok(bodies)
}

fn empty_body() -> Json {
    json!({ "snapshotRevision": null, "appliedThrough": 0, "empty": true, "pending": false })
}

fn storage(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: format!("reading the oracle state: {error}"),
    }
}

fn sync_failed(error: SyncError) -> CliError {
    CliError::Refused(format!("the first sync failed: {error}"))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use rusqlite::Connection;

    use super::{body_coverage, missing_bodies};
    use crate::cli::{Command, Parsed, parse};

    #[test]
    fn a_missing_body_is_one_the_server_holds() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sync_items (item_id TEXT, item_type TEXT, deleted_at TEXT, corrupt_reason TEXT);
             CREATE TABLE yjs_snapshots (doc_id TEXT);
             CREATE TABLE yjs_updates (doc_id TEXT);
             INSERT INTO sync_items VALUES
               ('snap', 'note', NULL, NULL), ('upd', 'journal', NULL, NULL),
               ('owed', 'note', NULL, NULL), ('attachment', 'note', NULL, NULL),
               ('gone', 'note', '1', NULL), ('bad', 'note', NULL, 'x'), ('task', 'task', NULL, NULL);
             INSERT INTO yjs_snapshots VALUES ('snap');
             INSERT INTO yjs_updates VALUES ('upd'), ('upd');",
        )
        .unwrap();
        let (live, without_body) = body_coverage(&conn).unwrap();
        assert_eq!(live, 4);
        assert_eq!(without_body, ["attachment", "owed"]);
        // The server holds a body for `owed` only: `attachment` never had one.
        let server: HashSet<String> = ["snap", "upd", "owed"].map(String::from).into();
        assert_eq!(missing_bodies(&without_body, &server), 1);
    }

    fn bench(line: &str) -> Result<Command, String> {
        let args = line.split_whitespace().map(String::from).collect();
        match parse(args).map_err(|error| error.message)? {
            Parsed::Run(invocation) => Ok(invocation.command),
            Parsed::Help => Err("help".to_string()),
        }
    }

    #[test]
    fn pass_interval_defaults_to_back_to_back_and_takes_whole_seconds() {
        let command = |vault: &str, secs, resume| Command::BenchBootstrap {
            vault: vault.to_string(),
            pass_interval_secs: secs,
            resume,
        };
        assert_eq!(
            bench("bench bootstrap --vault v-1"),
            Ok(command("v-1", 0, false))
        );
        assert_eq!(
            bench("bench bootstrap --vault v-1 --pass-interval 30"),
            Ok(command("v-1", 30, false))
        );
        assert_eq!(
            bench("bench bootstrap --vault v-1 --resume --pass-interval 30"),
            Ok(command("v-1", 30, true))
        );
        assert_eq!(
            bench("bench oracle-state --vault v-1"),
            Ok(Command::BenchOracleState {
                vault: "v-1".to_string()
            })
        );
        for line in [
            "bench bootstrap --vault v-1 --pass-interval",
            "bench bootstrap --vault v-1 --pass-interval 1.5",
            "bench bootstrap --vault v-1 --pass-interval -3",
            "bench bootstrap --vault v-1 --resume --resume-later",
            "bench oracle-state",
        ] {
            assert!(bench(line).is_err(), "`{line}` should not parse");
        }
    }
}
