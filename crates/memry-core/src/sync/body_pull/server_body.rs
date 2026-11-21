//! The server's whole body of one document, read and opened but not stored
//! (#5354). The revive heal judges from it whether a fresh device can
//! integrate what the server holds.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::Value as Json;

use crate::protocol::http::RetryPolicy;

use super::{BodyPull, BodyPullError, BodyPullReport, MAX_PAGES_PER_DOCUMENT, PackedUpdate};

impl BodyPull {
    /// The snapshot, then every update above it, each opened. `None` when the
    /// body cannot be judged: an entry that does not open, or a log longer
    /// than [`MAX_PAGES_PER_DOCUMENT`] pages. Adds the requests it sent.
    pub(crate) async fn read_server_body(
        &self,
        doc_id: &str,
        requests: &mut usize,
    ) -> Result<Option<Vec<Vec<u8>>>, BodyPullError> {
        let mut report = BodyPullReport::default();
        let read = self.read_all(doc_id, &mut report).await;
        *requests += report.requests;
        read
    }

    async fn read_all(
        &self,
        doc_id: &str,
        report: &mut BodyPullReport,
    ) -> Result<Option<Vec<Vec<u8>>>, BodyPullError> {
        report.requests += 1;
        let body: Json = self
            .http
            .send_json(
                self.request("GET", &format!("/sync/crdt/snapshot/{doc_id}"))
                    .retry(RetryPolicy::polled()),
            )
            .await?;
        let mut blobs = Vec::new();
        let mut since = 0;
        if let Some(encoded) = body.get("snapshot").and_then(Json::as_str) {
            let signer = body.get("signerDeviceId").and_then(Json::as_str);
            let Some(snapshot) = self.open(doc_id, signer, encoded) else {
                return Ok(None);
            };
            blobs.push(snapshot);
            since = body
                .get("sequenceNum")
                .and_then(Json::as_i64)
                .unwrap_or_default();
        }
        for _ in 0..MAX_PAGES_PER_DOCUMENT {
            let page = self.fetch_page(doc_id, since, report).await?;
            for entry in &page.updates {
                if entry.sequence_num <= since {
                    continue;
                }
                let signer = entry.signer_device_id.as_deref();
                let Some(update) = self.open(doc_id, signer, &entry.data) else {
                    return Ok(None);
                };
                blobs.push(update);
                since = entry.sequence_num;
            }
            if !page.has_more {
                return Ok(Some(blobs));
            }
        }
        Ok(None)
    }

    fn open(&self, doc_id: &str, signer: Option<&str>, encoded: &str) -> Option<Vec<u8>> {
        let packed = BASE64.decode(encoded).ok()?;
        self.cipher
            .open(&PackedUpdate {
                doc_id,
                signer_device_id: signer,
                packed: &packed,
            })
            .ok()
    }
}
