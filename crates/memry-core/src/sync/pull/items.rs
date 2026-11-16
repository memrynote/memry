//! Decoding a page's items and fetching its note bodies: the pull loop's
//! halves that touch neither the cursor nor the apply.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::Value as Json;

use crate::sync::crypto_batch::off_runtime;

use super::{PullError, PullLoop, PullReport, now_ms};
use crate::storage::repositories::sync_items;
use crate::sync::apply::{self, Pending};
use crate::sync::changes_page::ChangesPage;
use crate::sync::hardening::purged;
use crate::sync::hardening::quarantine::{self, SecurityWarning};
use crate::sync::note_body_feed::{self, FeedClient, FetchedBodies};
use crate::sync::pull_decode::{self, Undecodable, server_cursor};

impl PullLoop {
    /// Decodes pulled items per item (§5.14): each one is pending or one
    /// recorded corrupt item. A hardened pull first skips, undecoded, every
    /// item permanently quarantined ([`quarantine::blocked`]), as Electron's
    /// pull does (`pull-coordinator.ts:806`).
    pub(super) async fn take_items(
        &self,
        items: Vec<Json>,
        report: &mut PullReport,
        pending: &mut Vec<Pending>,
    ) -> Result<(), PullError> {
        let items = if self.hardened {
            let blocked = self
                .db
                .call(|conn| quarantine::blocked(conn, now_ms()))
                .await?;
            let (skipped, kept): (Vec<Json>, Vec<Json>) = items
                .into_iter()
                .partition(|item| blocked.contains(&(field(item, "type"), field(item, "id"))));
            report.skipped += skipped.len();
            kept
        } else {
            items
        };
        let mut warnings = Vec::new();
        for (item, decoded) in self.decode_batch(items).await? {
            match decoded {
                Ok(decoded) => pending.push(decoded),
                Err(corrupt) => {
                    report.corrupt += 1;
                    warnings.extend(self.record_corrupt(&item, &corrupt).await?);
                }
            }
        }
        self.warn(warnings).await;
        Ok(())
    }

    /// Pushes the purged tombstones that apply onto `pending`
    /// ([`purged::applicable`]) and answers every id an entry named, which
    /// the page never applies untyped (§5.12.1). `from_zero` skips them all
    /// (a run from cursor 0); a hardened pull also skips a permanently
    /// quarantined item, as Electron's page does (`pull-coordinator.ts:813-820`).
    pub(super) async fn take_markers(
        &self,
        entries: purged::Entries,
        from_zero: bool,
        pending: &mut Vec<Pending>,
    ) -> Result<BTreeSet<String>, PullError> {
        let named = entries.named.clone();
        if entries.markers.is_empty() && entries.refused.is_empty() {
            return Ok(named);
        }
        let blocked = if self.hardened && !from_zero {
            self.db
                .call(|conn| quarantine::blocked(conn, now_ms()))
                .await?
        } else {
            BTreeSet::new()
        };
        let skip = |marker: &purged::Marker| {
            from_zero || blocked.contains(&(marker.item_type.clone(), marker.item_id.clone()))
        };
        let keys = self.signer_keys.as_deref();
        pending.extend(purged::applicable(entries, skip, keys, &self.http, &self.db).await?);
        Ok(named)
    }

    /// Tells the observers each quarantine this pull recorded.
    pub(super) async fn warn(&self, warnings: Vec<SecurityWarning>) {
        if let Some(observers) = &self.observers {
            observers.security_warnings(warnings).await;
        }
    }

    /// Opens and decodes `items`, in order, on `spawn_blocking`: a page's
    /// envelope opens and signature checks are CPU work that must not hold a
    /// runtime worker (#3534).
    pub(super) async fn decode_batch(
        &self,
        items: Vec<Json>,
    ) -> Result<Vec<(Json, Result<Pending, Undecodable>)>, PullError> {
        let declaration = self.declaration.clone();
        let cipher = Arc::clone(&self.cipher);
        let decoded = off_runtime("decoding a pulled page", move || {
            items
                .into_iter()
                .map(|item| {
                    let decoded = pull_decode::decode(&declaration, cipher.as_ref(), &item);
                    (item, decoded)
                })
                .collect()
        })
        .await?;
        Ok(decoded)
    }

    /// The `items` array of a `POST /sync/pull` body, taken out of it; `None`
    /// when the body is not a pull envelope (§5.14).
    pub(super) fn pulled_items(body: &mut Json) -> Option<Vec<Json>> {
        match body.get_mut("items").map(Json::take) {
            Some(Json::Array(items)) => Some(items),
            _ => None,
        }
    }

    /// [`note_body_feed::fetch`] for this page, when bodies are declared.
    ///
    /// The bodies dropped unfetched are those of a note or journal this page
    /// deletes: a typed tombstone of a document type, or an id in `deleted`
    /// with no typed item, which deletes every row under it (§5.12.1). A tag
    /// that shares a note's id deletes no body.
    pub(super) async fn fetch_note_bodies(
        &self,
        page: &ChangesPage,
        pending: &[Pending],
    ) -> Result<FetchedBodies, PullError> {
        let Some(cipher) = self.bodies.clone() else {
            return Ok(FetchedBodies::default());
        };
        let dropped: Vec<String> = page
            .deleted
            .iter()
            .filter(|id| {
                let typed: Vec<&Pending> = pending
                    .iter()
                    .filter(|item| item.item_id() == *id)
                    .collect();
                typed.is_empty()
                    || typed.iter().any(|item| {
                        matches!(item, Pending::Tombstone { .. })
                            && apply::DOCUMENT_TYPES.contains(&item.item_type())
                    })
            })
            .cloned()
            .collect();
        let entries = page.note_bodies.clone();
        let held = self
            .db
            .call(move |conn| note_body_feed::held_bodies(conn, entries.as_deref()))
            .await?;
        let request = |method: &str, path: &str| self.request(method, path);
        let client = FeedClient {
            http: &self.http,
            request: &request,
            cipher,
        };
        Ok(note_body_feed::fetch(&client, page.note_bodies.as_deref(), &dropped, &held).await)
    }

    /// Records a corrupt item against its row when the wire told us enough to
    /// find one (§5.14, chapter 13 §13.2 rule 5). In a hardened pull a
    /// signature that did not verify is also one failure in the quarantine,
    /// in the same writer call, and its warning is returned.
    ///
    /// An item so malformed that neither its id nor its type is readable is
    /// counted and nothing else: there is no row to flag, and inventing a key
    /// for it would put an unaddressable row in `sync_items` forever.
    pub(super) async fn record_corrupt(
        &self,
        item: &Json,
        corrupt: &Undecodable,
    ) -> Result<Option<SecurityWarning>, PullError> {
        let (Some(item_id), Some(item_type)) = (
            item.get("id").and_then(Json::as_str),
            item.get("type").and_then(Json::as_str),
        ) else {
            return Ok(None);
        };
        let item_id = item_id.to_owned();
        let item_type = item_type.to_owned();
        let reason = corrupt.reason.clone();
        let cursor = server_cursor(item);
        let quarantined =
            (self.hardened && corrupt.signature_invalid).then(|| field(item, "signerDeviceId"));
        let now = now_ms();
        let eviction_logged = Arc::clone(&self.eviction_logged);
        let warning = self
            .db
            .call(move |conn| {
                sync_items::upsert_metadata_only(conn, &item_type, &item_id, now, cursor)?;
                sync_items::mark_corrupt(conn, &item_type, &item_id, &reason, now)?;
                quarantined
                    .map(|signer| {
                        quarantine::record_failure(
                            conn,
                            quarantine::Failure {
                                item_type: &item_type,
                                item_id: &item_id,
                                signer_device_id: &signer,
                                error: &reason,
                            },
                            now,
                            &eviction_logged,
                        )
                    })
                    .transpose()
            })
            .await?;
        Ok(warning)
    }
}

/// A string field of a wire item, empty when absent.
pub(super) fn field(item: &Json, key: &str) -> String {
    item.get(key)
        .and_then(Json::as_str)
        .unwrap_or_default()
        .to_owned()
}
