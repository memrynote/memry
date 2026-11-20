//! Fresh-device pack bootstrap, chapter 08 (#5232).
//!
//! A cold vault spends a request or two per item without packs: a
//! `POST /sync/pull` share per record, a snapshot GET and an updates GET per
//! body. One pack carries hundreds of them, so a fresh device walks
//! `GET /sync/packs` first.
//!
//! - **Records**: [`PackBootstrap::run_records`] (§8.4.2). Each entry carries
//!   the pull item's meta and goes through the `/sync/pull` apply.
//! - **Bodies**: [`PackBootstrap::run_bodies`] (§8.4.3, §8.10). Snapshot and
//!   update entries apply only as far as a body check read after the pack
//!   bytes confirms them.
//!
//! **Every pack failure is a fallback** (§8.0: a pack is a derived cache). An
//! old server's 404, no presigned URL, an expired URL, a bad digest or an
//! unverifiable entry leaves the affected items to the item-granular passes.
//! Only a local storage failure fails the first sync.

use std::path::PathBuf;
use std::sync::Arc;

use crate::protocol::http::HttpClient;
use crate::storage::Db;

mod bodies;
pub mod body_plan;
mod listing;
mod records;

pub use bodies::{BODY_CHUNK_BYTES, BODY_CHUNK_ENTRIES, BodyPackReport};
pub(crate) use listing::query_encode;
pub use listing::{Coverage, Listing, PACK_LIST_PAGE_LIMIT, PackSummary, list, tail_start};
pub use records::{
    META_RECORD_PACKS_DONE, META_RECORD_UNUSABLE_BELOW, RECORD_CHUNK_BYTES, RECORD_CHUNK_ENTRIES,
    RECORD_DOWNLOAD_WIDTH, RecordPackReport,
};

use super::body_pull::BodyPull;

pub struct PackBootstrap {
    http: Arc<HttpClient>,
    db: Db,
    bodies: Arc<BodyPull>,
    vault_id: Option<String>,
    /// Where body packs are held between their download and their checks.
    /// Without one no body pack is used.
    spill_dir: Option<PathBuf>,
}

impl PackBootstrap {
    pub fn new(http: Arc<HttpClient>, db: Db, bodies: Arc<BodyPull>) -> Self {
        Self {
            http,
            db,
            bodies,
            vault_id: None,
            spill_dir: None,
        }
    }

    pub fn with_vault(mut self, vault_id: &str) -> Self {
        self.vault_id = Some(vault_id.to_owned());
        self
    }

    /// A directory this bootstrap owns: it is created, filled with the body
    /// packs of one run, and removed when the body phase ends.
    pub fn with_spill_dir(mut self, dir: PathBuf) -> Self {
        self.spill_dir = Some(dir);
        self
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}
