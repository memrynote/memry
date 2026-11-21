//! The record pull loop, chapter 05 and data-model §C.3, §D.3 (FR-032).
//!
//! One page is: `GET /sync/changes` for the refs, `POST /sync/pull` for the
//! bodies of those refs **unioned with the page's `deleted` ids**, apply in
//! rank order, then advance the cursor. In that order and no other. The first
//! page of an incremental run asks for inline payloads (§5.11.2), and only the
//! ids no inline item names go to `POST /sync/pull`. A loop built
//! [`PullLoop::with_note_bodies`] also declares `note_body`: the page's bodies
//! are fetched before the apply and land in the transaction that writes the
//! cursor ([`super::note_body_feed`], chapter 07 §7.17).
//!
//! Five rules shape every branch below, and four of them are about not losing
//! a user's data on a page that went wrong:
//!
//! - **One global record cursor per device** (§5.11), a decimal string,
//!   advanced to `nextCursor` **only after the page's items were applied**.
//!   Never a per-type cursor: the feed is one ordered stream. The `scope`
//!   column exists for `crdt:<docId>`, which is a different feed.
//! - **Schema validation is per item, never per page** (§5.14). One malformed
//!   item is recorded corrupt and skipped; it never poisons its 99 page mates.
//!   A whole-page parse drops the page, and on a first sync that wedges every
//!   item sharing a chunk with one bad row.
//! - **The breaker** (§5.14): a page that yielded nothing, produced at least
//!   one new corrupt item and asked for at least one id advances the cursor
//!   *and* refuses the run, so no success state is written. Advancing without
//!   refusing loses data silently; refusing without advancing wedges the device
//!   on one poisoned page forever. Both halves or neither.
//! - **A `/sync/pull` body that is not a pull envelope refuses the run and
//!   holds the cursor** (§5.14, #2285). That is a server fault, not a poisoned
//!   item: the page must still be there to re-pull once the server is fixed.
//! - **A tombstone's body is never applied** (§5.12), but its envelope opens
//!   and its signature verifies like any record's before it deletes anything
//!   (§5.14). A present `deletedAt` overrides the declared `operation`, and an
//!   id in `deleted` with no ref row has no type on the wire at all (§5.12.1).
//!
//! The loop never parses a payload into a typed struct: it hands the decrypted
//! bytes to [`super::apply::apply_page`], which chooses the item's merge
//! algorithm once (chapter 06 §6.8) and stores the bytes verbatim either way
//! (chapter 13 §13.2). **This file must not learn an item type's name**: the
//! one dispatch lives there, so that a route added later cannot forget it.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde_json::{Value as Json, json};

use crate::crypto::agent_envelope::AtRestKey;
use crate::protocol::envelope::{EnvelopeError, RecordEnvelope};
use crate::protocol::http::{ApiRequest, Auth, HttpClient, SYNC_TYPES_HEADER, VAULT_ID_HEADER};
use crate::protocol::types::Declaration;
use crate::storage::Db;

use super::apply::{self, Pending};
use super::body_pull::CrdtCipher;
use super::changes_page::{ChangesPage, read_changes_page, requested_ids, uncovered_ids};
use super::driver::Observers;
use super::driver::observer::AppliedFeed;
use super::feed_restart;
use super::hardening::orphans::OrphanRepair;
use super::hardening::purged::{self, SignerKeys};
use super::hardening::stale_cursor::{self, StaleCursor};
use super::note_body_feed::NOTE_BODY_SYNC_TYPE;

use super::store::{self, RECORD_CURSOR_SCOPE};

/// §5.10.2: a new client SHOULD request the server's ceiling. Five times fewer
/// round trips against the same rate-limit budget, and chapter 10 §10.6's
/// first-sync arithmetic assumes it. The server clamps rather than rejects, so
/// **a client MUST NOT infer its page size from what it asked for** (§5.10.1).
pub const PULL_PAGE_LIMIT: u32 = 500;

/// `POST /sync/pull` takes at most 100 ids (§5.10).
pub const MAX_PULL_IDS: usize = 100;

/// Opens one pulled envelope.
///
/// A seam rather than a direct call to [`crate::protocol::envelope::decrypt`] because opening a
/// record needs the vault key **and** the signer's Ed25519 public key resolved
/// by `signerDeviceId` (chapter 04 §4.8, chapter 01 §1.4), and the key
/// directory is not this task's. The loop's job is to decide what a failure
/// here means, which is the same thing whatever supplies the keys: one corrupt
/// item, never a dropped page.
pub trait RecordCipher: Send + Sync {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError>;
}

pub use super::pull_report::{PullError, PullReport};

mod apply_step;
mod items;

pub use super::feed_restart::{META_CURSOR_SKIP_REPAIR, META_RECORD_DECLARATION};

mod shared_apply;

/// The pull loop. One per vault; cheap to clone through the `Arc`s it holds.
pub struct PullLoop {
    http: Arc<HttpClient>,
    db: Db,
    declaration: Declaration,
    cipher: Arc<dyn RecordCipher>,
    /// Set when the feed pull declares `note_body` (chapter 07 §7.17).
    bodies: Option<Arc<dyn CrdtCipher>>,
    vault_id: Option<String>,
    /// This device's clock id, which a canvas conflict copy is clocked under.
    clock_device: Option<String>,
    /// The vault key agent records are sealed under at apply (chapter 04 §4.17).
    at_rest: AtRestKey,
    /// Told what each page applied, after it commits ([`Observers`]).
    observers: Option<Arc<Observers>>,
    /// The desktop ledgers run ([`PullLoop::with_hardening`]).
    hardened: bool,
    /// Whether this loop printed the quarantine cap's log line
    /// ([`super::hardening::quarantine`]), as Electron's per-manager
    /// `evictionLogged`.
    eviction_logged: Arc<AtomicBool>,
    /// The extended-offline reset ([`PullLoop::with_stale_cursor`]).
    stale_cursor: Option<Arc<StaleCursor>>,
    /// The parents this loop fetched for orphan repair.
    orphans: Arc<OrphanRepair>,
    /// The keys purged tombstones verify under ([`PullLoop::with_signer_keys`]).
    signer_keys: Option<Arc<dyn SignerKeys>>,
    /// The vault a delete reads a note's file in ([`PullLoop::with_vault_root`]).
    vault_root: Option<PathBuf>,
}

impl PullLoop {
    pub fn new(
        http: Arc<HttpClient>,
        db: Db,
        declaration: Declaration,
        cipher: Arc<dyn RecordCipher>,
    ) -> Self {
        Self {
            http,
            db,
            declaration,
            cipher,
            bodies: None,
            vault_id: None,
            clock_device: None,
            at_rest: AtRestKey::default(),
            observers: None,
            hardened: false,
            eviction_logged: Arc::default(),
            stale_cursor: None,
            orphans: Arc::default(),
            signer_keys: None,
            vault_root: None,
        }
    }

    /// Applies the purged tombstones the declaration makes visible, verified
    /// under `keys` ([`super::hardening::purged`]). Without keys every marker
    /// is refused, never applied.
    pub fn with_signer_keys(mut self, keys: Arc<dyn SignerKeys>) -> Self {
        self.signer_keys = Some(keys);
        self
    }

    /// Runs the desktop ledgers (decision K2, #3534): a permanently
    /// quarantined item is skipped undecoded and a bad signature counts
    /// toward its quarantine ([`super::hardening::quarantine`]), and a run
    /// starts by refetching the rows marked corrupt an hour ago or more
    /// ([`super::hardening::corrupt`]). `SyncDriver` builds its pulls with
    /// it; iOS's `VaultSync::sync_now` does not, so its pull is unchanged.
    pub fn with_hardening(mut self) -> Self {
        self.hardened = true;
        self
    }

    /// Resets the record cursor before the first page of the run after a
    /// reconnect more than a day after the last successful pull
    /// ([`super::hardening::stale_cursor`]). Only the driver's feed pull.
    pub fn with_stale_cursor(mut self, stale: Arc<StaleCursor>) -> Self {
        self.stale_cursor = Some(stale);
        self
    }

    /// Tells `observers` what each page applied, once the page has committed.
    pub fn with_observers(mut self, observers: Arc<Observers>) -> Self {
        self.observers = Some(observers);
        self
    }

    /// Declares `note_body` on the feed's `GET /sync/changes` and lands the
    /// page's bodies before its cursor ([`note_body_feed`], #2304). Only the
    /// feed pull declares it: the token is kept out of
    /// [`PullLoop::request`], which the first sync's refs pass also uses and
    /// which lands no bodies.
    pub fn with_note_bodies(mut self, cipher: Arc<dyn CrdtCipher>) -> Self {
        self.bodies = Some(cipher);
        self
    }

    /// The data database this loop applies into.
    pub fn db(&self) -> &Db {
        &self.db
    }

    /// The declaration every request of this loop carries.
    pub fn declaration(&self) -> &Declaration {
        &self.declaration
    }

    /// This device's clock id, when the loop was given one.
    pub fn clock_device(&self) -> Option<&str> {
        self.clock_device.as_deref()
    }

    /// The client every record call goes out through. Public for the same
    /// reason [`PullLoop::request`] is: the first-sync sub-sequence drives
    /// `/sync/changes` itself and must not build a second client.
    pub fn http(&self) -> &HttpClient {
        &self.http
    }

    /// The keys a delete's signer resolves under ([`PullLoop::with_signer_keys`]).
    pub(crate) fn signer_keys(&self) -> Option<&dyn SignerKeys> {
        self.signer_keys.as_deref()
    }

    /// This device's clock id (chapter 01 §1.5), so a diverged canvas can keep
    /// the local drawing as a conflict copy instead of being recorded corrupt.
    pub fn with_clock_device(mut self, device_id: &str) -> Self {
        self.clock_device = Some(device_id.to_owned());
        self
    }

    /// The vault key the apply seals agent records under. Without one they are
    /// stored plain and pending until `Vault::set_at_rest_key` seals them.
    pub fn with_at_rest_key(mut self, key: AtRestKey) -> Self {
        self.at_rest = key;
        self
    }

    /// The vault folder whose files hold the notes' bodies (desktop). A delete
    /// over a body log that does not replay keeps the note's file text
    /// instead ([`super::delete_keep`], #5343).
    pub fn with_vault_root(mut self, root: PathBuf) -> Self {
        self.vault_root = Some(root);
        self
    }

    /// The `X-Memry-Vault-Id` header's value, when a vault is selected (§5.2).
    pub fn with_vault(mut self, vault_id: &str) -> Self {
        self.vault_id = Some(vault_id.to_owned());
        self
    }

    /// The vault [`PullLoop::with_vault`] selected.
    pub fn vault_id(&self) -> Option<&str> {
        self.vault_id.as_deref()
    }

    /// Drains up to `max_pages` pages, stopping at the end of the feed or at
    /// the first refusal.
    ///
    /// A refusal stops the loop deliberately: the cursor has moved past a page
    /// that produced only corruption, and continuing would report a successful
    /// run that skipped it. After a non-envelope pull body the cursor held, and
    /// continuing would re-read the same page.
    pub async fn run(&self, max_pages: u32) -> Result<PullReport, PullError> {
        let repairing = self.begin_run().await?;
        let mut total = PullReport::default();
        for index in 0..max_pages {
            let page = if index == 0 {
                self.pull_first_page().await?
            } else {
                self.pull_page().await?
            };
            total.pages += page.pages;
            total.applied += page.applied;
            total.deleted += page.deleted;
            total.skipped += page.skipped;
            total.corrupt += page.corrupt;
            total.expired += page.expired;
            total.dropped_pages += page.dropped_pages;
            total
                .purged_documents
                .extend(page.purged_documents.iter().cloned());
            total
                .advanced_documents
                .extend(page.advanced_documents.iter().cloned());
            total.cursor = page.cursor.clone();
            total.has_more = page.has_more;
            total.refused = page.refused;
            if page.refused || !page.has_more {
                break;
            }
        }
        self.end_run(&total, repairing).await?;
        Ok(total)
    }

    /// What a run does after its last page, when it reached the head of the
    /// feed unrefused: records the cursor-skip repair done when `repairing`,
    /// then, hardened and when the run delivered, the orphan repair
    /// ([`super::hardening::orphans`]), now that the deletes and moves pushed
    /// before it have all landed. An orphan-repair failure is logged, not
    /// returned: the pages have committed, and the next delivering run
    /// repairs again. The run's signer misses end here, so a fetch after it
    /// (the manifest check) looks a missing signer up again.
    pub async fn end_run(&self, total: &PullReport, repairing: bool) -> Result<(), PullError> {
        if total.refused || total.has_more {
            return Ok(());
        }
        if let Some(keys) = &self.signer_keys {
            keys.forget_absent();
        }
        if repairing {
            self.db
                .call(|conn| feed_restart::finish_cursor_skip_repair(conn))
                .await?;
        }
        let delivered = total.applied + total.deleted > 0;
        if self.hardened
            && delivered
            && let Err(error) = self.orphans.run(self).await
        {
            eprintln!("memry-core: the orphan repair failed; the next run repairs again: {error}");
        }
        Ok(())
    }

    /// Whether the stored record cursor is at or past `cursor`. `false` when
    /// there is no cursor or it will not read: pulling is the safe answer.
    pub async fn has_applied_through(&self, cursor: i64) -> bool {
        let stored = self
            .db
            .call(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
            .await;
        let applied = stored
            .ok()
            .flatten()
            .and_then(|text| text.parse::<i64>().ok());
        applied.is_some_and(|applied| cursor <= applied)
    }

    /// What a run does before its first page: [`feed_restart`]'s two rules,
    /// after the stale-cursor reset when a reconnect armed it. Answers whether
    /// the cursor-skip repair is pending, for [`PullLoop::end_run`]. Public
    /// because [`super::engine::SyncEngine`] walks the pages itself.
    pub async fn begin_run(&self) -> Result<bool, PullError> {
        let current = self.declaration.header_value();
        let reconnected = self.stale_cursor.as_ref().is_some_and(|stale| stale.take());
        Ok(self
            .db
            .call(move |conn| {
                let now = now_ms();
                if reconnected {
                    stale_cursor::reset_if_stale(conn, now)?;
                }
                feed_restart::restart_on_new_declaration(conn, &current, now)?;
                feed_restart::begin_cursor_skip_repair(conn, now)
            })
            .await?)
    }

    /// One page: refs, bodies, apply, advance.
    pub async fn pull_page(&self) -> Result<PullReport, PullError> {
        self.page(false).await
    }

    /// The first page of a run. When a cursor is stored the pull is
    /// incremental, so it asks `GET /sync/changes?inline=1` (chapter 05
    /// §5.11.2, #2292) and a small page applies without a `POST /sync/pull`.
    /// With no cursor the feed is read from the start, which is backlog and
    /// keeps 500-ref pages. A server that ignores the query sends no `inline`
    /// and the page is pulled exactly as [`PullLoop::pull_page`] pulls it.
    ///
    /// Every run starts here, so it first refetches what another app version
    /// refused and, hardened, the rows held corrupt
    /// ([`PullLoop::retry_refused`], #4453).
    pub async fn pull_first_page(&self) -> Result<PullReport, PullError> {
        self.retry_refused().await;
        if let Some(keys) = &self.signer_keys {
            keys.forget_absent();
        }
        self.page(true).await
    }

    async fn page(&self, ask_inline: bool) -> Result<PullReport, PullError> {
        let (cursor, from_zero) = self
            .db
            .call(|conn| purged::cursor_and_from_zero(conn))
            .await?;
        let inline = ask_inline && cursor.is_some();
        let mut page = self.fetch_changes(cursor.as_deref(), inline).await?;
        let mut report = PullReport {
            pages: 1,
            has_more: page.has_more,
            ..PullReport::default()
        };

        let ids = requested_ids(&page);
        let mut pending: Vec<Pending> = Vec::with_capacity(ids.len());

        let fetch = uncovered_ids(&page, &ids);

        self.take_items(std::mem::take(&mut page.inline), &mut report, &mut pending)
            .await?;
        let mut markers = purged::Entries::default();
        for chunk in fetch.chunks(MAX_PULL_IDS) {
            let mut body = self.fetch_bodies(chunk).await?;
            markers.read(&body, chunk);
            let Some(items) = Self::pulled_items(&mut body) else {
                // §5.14 (#2285): not a pull envelope at all, which is a server
                // contract regression. Nothing from the page is applied and the
                // cursor holds, so the page is still there to re-pull once the
                // server is fixed; the run is refused so no success is written.
                report.dropped_pages += 1;
                report.refused = true;
                report.cursor = cursor;
                return Ok(report);
            };
            self.take_items(items, &mut report, &mut pending).await?;
        }
        let named = self.take_markers(markers, from_zero, &mut pending).await?;

        // §5.13: rank, then a **stable** sort, so two items of the same rank
        // keep the order the server sent them in. `sort_by_key` is stable.
        pending.sort_by_key(|item| apply::apply_rank(item.item_type()));

        // §5.12.1 (#5340): an id in `deleted` deletes only through a verified
        // typed delete or an attested marker. A bare id is unsigned, so it
        // deletes nothing, as in Electron (`changes-page.ts:38` only fetches
        // it); an item the pull returned and refused never falls through here.
        let bare = page
            .deleted
            .iter()
            .filter(|id| !typed_covers(&pending, id) && !named.contains(*id))
            .count();
        if bare > 0 {
            eprintln!(
                "memry-core: {bare} deleted id(s) on the page at cursor {cursor:?} had no verified delete, ignored"
            );
        }

        let bodies = self.fetch_note_bodies(&page, &pending).await?;
        // Only a loop that lands bodies owes them: its caller is the one that
        // settles the debts (#2297 review A-7).
        let owe_bodies = self.bodies.is_some();
        let mut feed = AppliedFeed::default();
        let requested = !ids.is_empty();
        let advanced = page.next_cursor.clone().or(cursor);
        let advance = apply_step::Advance {
            bodies,
            cursor: advanced.clone(),
            at_head: !report.has_more,
        };
        let (outcomes, advanced_documents) = self
            .apply_all(pending, Vec::new(), owe_bodies, Some(advance), &mut feed)
            .await?;
        report.applied += outcomes.applied;
        report.deleted += outcomes.deleted;
        report.skipped += outcomes.skipped;
        report.corrupt += outcomes.corrupt;
        report.expired += outcomes.expired;
        report.purged_documents.extend(outcomes.purged_documents);
        // §5.14's breaker, all three conditions or none.
        report.refused = breaker(
            report.applied + report.deleted + report.skipped + report.expired,
            report.corrupt,
            requested,
        );
        report.advanced_documents = advanced_documents;
        report.cursor = advanced;
        // Told after the page committed, never inside it: an observer reads the row.
        self.tell(feed).await;
        if let Some(observers) = &self.observers {
            observers
                .bodies_applied(report.advanced_documents.clone())
                .await;
        }

        Ok(report)
    }

    /// Fetches, decodes and applies a named set of ids, **without touching
    /// the record cursor**.
    ///
    /// The first sync's metadata pass (T122) drives this: its work list is
    /// the `payload_state = 'metadata-only'` rows the refs pass recorded, not
    /// a position in the feed, so there is no cursor to move and §5.14's page
    /// breaker — which is about a page of the feed — does not apply. Every
    /// other rule does: per-item validation, the §5.13 apply order, and one
    /// corrupt item never poisoning its chunk mates.
    pub async fn fetch_ids(&self, ids: &[String]) -> Result<PullReport, PullError> {
        let mut report = PullReport::default();
        let mut pending: Vec<Pending> = Vec::with_capacity(ids.len());

        let mut markers = purged::Entries::default();
        for chunk in ids.chunks(MAX_PULL_IDS) {
            let mut body = self.fetch_bodies(chunk).await?;
            markers.read(&body, chunk);
            let Some(items) = Self::pulled_items(&mut body) else {
                report.dropped_pages += 1;
                continue;
            };
            self.take_items(items, &mut report, &mut pending).await?;
        }
        self.take_markers(markers, false, &mut pending).await?;

        pending.sort_by_key(|item| apply::apply_rank(item.item_type()));
        let mut feed = AppliedFeed::default();
        let (outcomes, _) = self
            .apply_all(pending, Vec::new(), true, None, &mut feed)
            .await?;
        self.tell(feed).await;
        report.applied += outcomes.applied;
        report.deleted += outcomes.deleted;
        report.skipped += outcomes.skipped;
        report.corrupt += outcomes.corrupt;
        report.expired += outcomes.expired;
        report.purged_documents.extend(outcomes.purged_documents);
        Ok(report)
    }

    async fn fetch_changes(
        &self,
        cursor: Option<&str>,
        inline: bool,
    ) -> Result<ChangesPage, PullError> {
        let mut path = format!("/sync/changes?limit={PULL_PAGE_LIMIT}");
        if let Some(cursor) = cursor {
            path.push_str("&cursor=");
            path.push_str(cursor);
        }
        if inline {
            path.push_str("&inline=1");
        }
        let mut request = self.request("GET", &path);
        if self.bodies.is_some() {
            let declared = self
                .declaration
                .header_value_with(Some(NOTE_BODY_SYNC_TYPE));
            request = request.header(SYNC_TYPES_HEADER, &declared);
        }
        let body: Json = self.http.send_json(request).await?;
        Ok(read_changes_page(&body))
    }

    async fn fetch_bodies(&self, ids: &[String]) -> Result<Json, PullError> {
        let request = self
            .request("POST", "/sync/pull")
            .json(&json!({ "itemIds": ids })); // §5.11.1, defect 50
        Ok(self.http.send_json(request).await?)
    }

    /// The request every record call is built from: session auth plus §5.3's
    /// negotiation header plus the vault. Public so the first-sync
    /// sub-sequence ([`super::first_sync`]) drives `/sync/changes` with the
    /// identical header set rather than a second, drifting copy of it.
    pub fn request(&self, method: &str, path: &str) -> ApiRequest {
        let mut request = ApiRequest::new(method, path)
            .auth(Auth::Session)
            // §5.3: negotiation is a header, not a query parameter.
            .header(SYNC_TYPES_HEADER, &self.declaration.header_value());
        if let Some(vault_id) = &self.vault_id {
            request = request.header(VAULT_ID_HEADER, vault_id);
        }
        request
    }
}

/// §5.14's breaker: a page that requested items, yielded none and met
/// corruption is refused.
fn breaker(yielded: usize, corrupt: usize, requested: bool) -> bool {
    yielded == 0 && corrupt > 0 && requested
}

fn typed_covers(pending: &[Pending], id: &str) -> bool {
    pending.iter().any(|item| item.item_id() == id)
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
