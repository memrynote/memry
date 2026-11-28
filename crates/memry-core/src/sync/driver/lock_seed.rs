//! The vault-lock seed the driver registers for a declaration that subscribes `vault_lock`.

use crate::api::errors::StorageError;
use crate::storage::Db;
use crate::sync::engine::PassSeed;

/// Gives each lock written before Step 16 its record (Electron's
/// `seedUnclocked`, [`crate::domain::vault_locks::seed_unsynced`]). Registered
/// only for a declaration that subscribes `vault_lock`: without it the device
/// never pulls a peer's edit of the lock, so its pushes would tick only its own
/// clock.
pub(super) struct VaultLockSeed {
    pub(super) db: Db,
    pub(super) device_id: String,
}

#[async_trait::async_trait]
impl PassSeed for VaultLockSeed {
    async fn seed(&self) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call(move |conn| {
                crate::domain::vault_locks::seed_unsynced(
                    conn,
                    &device_id,
                    crate::sync::pull::now_ms(),
                )
            })
            .await?;
        Ok(())
    }
}
