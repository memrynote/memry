//! The desktop sync driver and the server vault binding on [`Vault`] (#3534).
//! Not part of the FFI surface: the Rust desktop shell is their only caller,
//! and iOS keeps [`Vault::sync`].

use std::sync::Arc;

use crate::api::auth::AuthSession;
use crate::api::errors::{StorageError, SyncError};
use crate::api::vault::Vault;
use crate::seams::reachability::Reachability;
use crate::sync::driver::{DriverConfig, DriverParts, SyncDriver};
use crate::sync::engine::PassSeed;
use crate::sync::server_vault;

impl Vault {
    /// Binds this vault to the server's vault `id` (decision K1 of #3534): the
    /// one op the sign-in binding calls, and the id every later request and
    /// socket of a driver carries. A driver already built keeps the id it was
    /// built with.
    #[doc(hidden)]
    pub fn bind_server_vault(&self, id: &str) -> Result<(), StorageError> {
        let id = id.to_owned();
        self.db
            .call_blocking(move |conn| server_vault::bind(conn, &id))
    }

    /// The bound server vault id, if any.
    #[doc(hidden)]
    pub fn server_vault_id(&self) -> Result<Option<String>, StorageError> {
        self.db.call_blocking(|conn| server_vault::bound(conn))
    }

    /// A [`SyncDriver`] over this vault and `session`. `seeds` run after the
    /// driver's own tag and lock seeds.
    #[doc(hidden)]
    pub async fn sync_driver(
        &self,
        session: Arc<AuthSession>,
        reachability: Arc<dyn Reachability>,
        config: DriverConfig,
        seeds: Vec<Arc<dyn PassSeed>>,
    ) -> Result<SyncDriver, SyncError> {
        SyncDriver::open(DriverParts {
            db: self.db.clone(),
            at_rest: self.at_rest_key.clone(),
            session,
            reachability,
            config,
            seeds,
        })
        .await
    }
}
