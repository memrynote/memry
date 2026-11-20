//! Presigned chunk GETs for downloads (§14.6), Electron's `AttachmentPresigner`
//! (`apps/desktop/src/main/sync/attachment-presign.ts`).
//!
//! A definitive "not here" (a 404 from a server that predates the route, a 501
//! or `STORAGE_PRESIGN_UNAVAILABLE` from a deployment without R2 credentials)
//! is remembered for ten minutes across transfers, so a download does not
//! probe the route again on every file. A transient failure (5xx, 429, no
//! network) only sends this batch through the Worker.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::api::errors::ApiError;
use crate::protocol::attachments::{AttachmentError, presign_all};
use crate::protocol::http::HttpClient;

/// `UNAVAILABLE_COOLDOWN_MS`.
pub const UNAVAILABLE_COOLDOWN_MS: i64 = 10 * 60 * 1000;
/// `PRESIGN_EXPIRY_SAFETY_MS`: clock-skew margin off the server's expiry.
const EXPIRY_SAFETY_MS: i64 = 30 * 1000;
/// A url is treated as stale ten minutes after it was issued, whatever the
/// server claimed, so a stuck clock cannot pin dead urls.
const MAX_WINDOW_MS: i64 = 10 * 60 * 1000;

/// Presigned urls over some chunk hashes, valid until `expires_at_ms`.
#[derive(Debug, Clone)]
pub struct UrlWindow {
    pub urls: HashMap<String, String>,
    pub expires_at_ms: i64,
}

/// Remembers, per vault, until when presigning is known to be unavailable.
#[derive(Debug, Default)]
pub struct Presigner {
    unavailable_until: Mutex<i64>,
}

impl Presigner {
    pub fn available(&self, now_ms: i64) -> bool {
        now_ms >= *self.lock()
    }

    /// Presigned GETs for `hashes`, or `None` when this transfer should use
    /// the Worker for them. Never an error.
    pub async fn window(
        &self,
        http: &HttpClient,
        vault_id: &str,
        hashes: &[String],
        now_ms: i64,
    ) -> Option<UrlWindow> {
        if hashes.is_empty() || !self.available(now_ms) {
            return None;
        }
        match presign_all(http, vault_id, hashes).await {
            Ok(Some(batch)) => Some(UrlWindow {
                urls: batch.urls,
                expires_at_ms: (batch.expires_at.saturating_mul(1000) - EXPIRY_SAFETY_MS)
                    .min(now_ms + MAX_WINDOW_MS),
            }),
            Ok(None)
            | Err(AttachmentError::Api(ApiError::Status {
                status: 404 | 501, ..
            })) => {
                *self.lock() = now_ms + UNAVAILABLE_COOLDOWN_MS;
                None
            }
            Err(_) => None,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, i64> {
        // A poisoned lock only means a panic elsewhere; the instant is valid.
        self.unavailable_until
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
