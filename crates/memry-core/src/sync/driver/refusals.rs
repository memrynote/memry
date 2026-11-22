//! The driver's re-pull of records refused for a signer missing from its
//! directory (chapter 01 §1.4.0, #5413, #5427).
//!
//! The refusals live in `meta` ([`unknown_signer`]), where neither a local
//! edit nor a quit loses them. They are re-pulled at open, over the directory
//! the open fetched, and at the start of every pass while one waits, over a
//! refetched directory, each at most [`unknown_signer::MAX_RETRIES`] times.

use crate::api::errors::StorageError;
use crate::sync::unknown_signer;

use super::SyncDriver;

impl SyncDriver {
    /// Re-pulls every refusal still waiting, under the pass gate. With
    /// `refetch`, only when one waits, and over a refetched directory. A failed refetch is logged and counts like a
    /// failed re-pull ([`unknown_signer::directory_failed`]).
    pub(super) async fn retry_refusals(&self, refetch: bool) -> Result<(), StorageError> {
        if refetch
            && !self
                .db
                .call(|conn| unknown_signer::any_waiting(conn))
                .await?
        {
            return Ok(());
        }
        let _gate = self.engine.hold_gate().await;
        if refetch && let Err(error) = self.cipher.refresh(&self.http).await {
            eprintln!("memry-core: refetching the device directory failed: {error}");
            return unknown_signer::directory_failed(&self.db, &error).await;
        }
        unknown_signer::retry(&self.db, &self.first.pull).await?;
        // `retry` counted the re-pull's own refusals. Settling them as fresh
        // misses would refuse them again with a full budget, every pass.
        self.cipher.forget_missed();
        Ok(())
    }
}
