//! The desktop sync driver and the server vault binding on [`Vault`] (#3534).
//! Not part of the FFI surface: the Rust desktop shell is their only caller,
//! and iOS keeps [`Vault::sync`].

use std::sync::Arc;

use crate::api::auth::AuthSession;
use crate::api::errors::{StorageError, SyncError};
use crate::api::vault::Vault;
use crate::seams::reachability::Reachability;
use crate::sync::driver::{ApplyObserver, DriverConfig, DriverParts, SyncDriver};
use crate::sync::engine::PassSeed;
use crate::sync::{account_binding, server_vault};

impl Vault {
    /// Binds this vault to the server's vault `id` (decision K1 of #3534): the
    /// one op the sign-in binding calls, and the id every later request and
    /// socket of a driver carries. Rebinding the same id is a no-op; another
    /// id is refused ([`server_vault::bind`]).
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

    /// The account binding as stored (`sync.account-binding.v1`, Electron's JSON), if any.
    #[doc(hidden)]
    pub fn account_binding(&self) -> Result<Option<String>, StorageError> {
        self.db.read_blocking(account_binding::read)
    }

    /// Stores the account binding JSON the shell decided on.
    #[doc(hidden)]
    pub fn set_account_binding(&self, json: &str) -> Result<(), StorageError> {
        let json = json.to_owned();
        self.db
            .call_blocking(move |conn| account_binding::write(conn, &json))
    }

    /// A task or inbox item exists ([`account_binding::has_local_rows`]).
    #[doc(hidden)]
    pub fn has_local_rows(&self) -> Result<bool, StorageError> {
        self.db.read_blocking(account_binding::has_local_rows)
    }

    /// A synced record carries a tick from a device not in `own`.
    #[doc(hidden)]
    pub fn has_foreign_history(&self, own: Vec<String>) -> Result<bool, StorageError> {
        self.db
            .read_blocking(move |conn| account_binding::has_foreign_history(conn, &own))
    }

    /// Ends the signed-out session's sync state ([`account_binding::clear_session_state`]).
    #[doc(hidden)]
    pub fn clear_sync_session_state(&self) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| account_binding::clear_session_state(conn))
    }

    /// A [`SyncDriver`] over this vault and `session`. `seeds` run after the
    /// driver's own tag and lock seeds; `observers` hear every page it applies,
    /// the re-pull its open runs included. Its passes share the vault's one pass
    /// gate with every other driver and [`crate::api::sync::VaultSync`] of it.
    /// Refused while no server vault is bound.
    #[doc(hidden)]
    pub async fn sync_driver(
        &self,
        session: Arc<AuthSession>,
        reachability: Arc<dyn Reachability>,
        config: DriverConfig,
        seeds: Vec<Arc<dyn PassSeed>>,
        observers: Vec<Arc<dyn ApplyObserver>>,
    ) -> Result<SyncDriver, SyncError> {
        SyncDriver::open(DriverParts {
            db: self.db.clone(),
            at_rest: self.at_rest_key.clone(),
            session,
            reachability,
            config,
            seeds,
            pass_gate: crate::api::sync::pass_gate(&self.id),
            observers,
        })
        .await
    }
}
