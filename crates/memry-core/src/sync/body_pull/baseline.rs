//! §7.8's baseline: when a document takes the server snapshot, and the
//! fetch and store of it.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::Value as Json;

use std::sync::Arc;

use super::{BodyPull, BodyPullError, BodyPullReport, PackedUpdate, RetryPolicy};
use crate::crdt::epoch::Epoch;
use crate::crdt::update_log;
use crate::sync::crdt_wire::SnapshotMeta;
use crate::sync::crypto_batch::off_runtime;

impl BodyPull {
    /// `GET /sync/crdt/snapshot/:noteId` and the store that follows it (§7.8,
    /// §7.11). Answers whether a baseline was actually taken. A body that
    /// moved off `epoch` meanwhile (#5356) stores nothing and is incomplete.
    pub(super) async fn fetch_baseline(
        &self,
        doc_id: &str,
        epoch: Epoch,
        cursor: i64,
        report: &mut BodyPullReport,
    ) -> Result<bool, BodyPullError> {
        report.requests += 1;
        let body: Json = self
            .http
            .send_json(
                self.request("GET", &format!("/sync/crdt/snapshot/{doc_id}"))
                    .retry(RetryPolicy::polled()),
            )
            .await?;

        // §7.11: `snapshot` is null when there is none. That is not a failure
        // and it is the ordinary answer for a document nobody has snapshotted.
        let Some(encoded) = body.get("snapshot").and_then(Json::as_str) else {
            return Ok(false);
        };
        let Ok(packed) = BASE64.decode(encoded) else {
            report.stopped.push(doc_id.to_owned());
            return Ok(false);
        };
        let sequence_num = body
            .get("sequenceNum")
            .and_then(Json::as_i64)
            .unwrap_or_default();
        let signer = body
            .get("signerDeviceId")
            .and_then(Json::as_str)
            .map(str::to_owned);
        // §7.11.1: the client MUST resolve the snapshot response's signer and
        // fail the baseline when it cannot.
        let cipher = Arc::clone(&self.cipher);
        let doc = doc_id.to_owned();
        let opened = off_runtime("opening a body snapshot", move || {
            cipher.open(&PackedUpdate {
                doc_id: &doc,
                signer_device_id: signer.as_deref(),
                packed: &packed,
            })
        })
        .await?;
        let Ok(snapshot) = opened else {
            report.stopped.push(doc_id.to_owned());
            return Ok(false);
        };
        let revision = body
            .get("revision")
            .and_then(Json::as_str)
            .map(str::to_owned);

        if !self
            .store_baseline(doc_id, epoch, snapshot, sequence_num, revision, cursor)
            .await?
        {
            report.incomplete.push(doc_id.to_owned());
            return Ok(false);
        }
        report.baselines += 1;
        Ok(true)
    }

    /// §7.8's second clause, against the locally stored revision.
    pub(super) async fn baseline_due(
        &self,
        doc_id: &str,
        meta: &SnapshotMeta,
    ) -> Result<bool, BodyPullError> {
        // #2299: a coversThrough push moves the watermark over rows it prunes,
        // and a cursor between the old and the new one never re-reads them.
        // Any snapshot whose revision this device does not hold is taken,
        // whatever its sequence; a held one never is.
        let doc = doc_id.to_owned();
        let stored = self
            .db
            .read(move |conn| update_log::server_revision(conn, &doc))
            .await?;
        // §7.5: compared for equality and for nothing else. A local NULL —
        // which is what a snapshot this device pushed stores, §7.13.4 — never
        // equals a server token, so it always yields to a baseline rather
        // than suppressing one.
        Ok(stored.as_deref() != Some(meta.revision.as_str()))
    }
}
