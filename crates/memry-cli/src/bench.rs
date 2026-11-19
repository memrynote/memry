//! `bench bootstrap --vault <id>`: a fresh-device bootstrap of one vault,
//! timed, for the bootstrap benchmark (`pnpm bench:bootstrap core`, #5223).
//!
//! It runs the shells' own path, not `pull`'s: [`VaultSync::first_sync`] (refs,
//! metadata, packs, the recent bodies), then the body step every later pass
//! runs ([`body_step::run`]) until no live document is owed a body. It never
//! pushes, so the vault on the server is only read.
//!
//! Every line on stdout is one JSON mark with a wall-clock `atMs`, so the
//! harness can line the marks up with the requests its proxy recorded.

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
use serde_json::{Value as Json, json};

use crate::session::{Cli, CliError};

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

/// Marks `records` once the metadata pass has applied every record.
#[derive(Default)]
struct Progress {
    phase: Mutex<Option<SyncPhase>>,
}

impl SyncProgressListener for Progress {
    fn progress(&self, progress: SyncProgress) {
        let mut phase = self.phase.lock().unwrap_or_else(|p| p.into_inner());
        if *phase != Some(progress.phase) {
            mark("phase", json!({ "phase": format!("{:?}", progress.phase) }));
            *phase = Some(progress.phase);
        }
        if progress.phase == SyncPhase::Metadata && progress.completed >= progress.total {
            mark("records", json!({ "applied": progress.completed }));
        }
    }
}

pub async fn bootstrap(cli: &Cli, vault: &str) -> Result<(), CliError> {
    // A fresh device: this profile's copy of the vault goes, the account and
    // device registration stay.
    let dir = cli.vault_dir(vault);
    if dir.exists() {
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
        if pass.documents == 0 {
            idle += 1;
            tokio::time::sleep(IDLE_PASS_WAIT).await;
        } else {
            idle = 0;
        }
    }

    let (live, with_body) = body_coverage(&db).await?;
    mark(
        "end",
        json!({ "liveDocuments": live, "withBody": with_body }),
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

/// Live notes and journals, and how many of them hold any body state locally.
async fn body_coverage(db: &Db) -> Result<(u64, u64), StorageError> {
    db.call(|conn| {
        conn.query_row(
            "SELECT COUNT(*), COUNT(b.doc_id) FROM sync_items i \
             LEFT JOIN (SELECT doc_id FROM yjs_snapshots UNION SELECT doc_id FROM yjs_updates) b \
               ON b.doc_id = i.item_id \
             WHERE i.item_type IN ('note', 'journal') AND i.deleted_at IS NULL \
               AND i.corrupt_reason IS NULL",
            [],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
        )
        .map_err(|error| StorageError::Failed {
            what: format!("counting local bodies: {error}"),
        })
    })
    .await
}

fn sync_failed(error: SyncError) -> CliError {
    CliError::Refused(format!("the first sync failed: {error}"))
}
