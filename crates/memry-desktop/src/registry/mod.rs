//! The app config file and the vault registry kept in it.

pub mod config;
pub(crate) mod config_lock;
pub mod create;
pub mod prefs;
pub mod vault_icon;
pub mod vaults;

pub use config::{AppConfig, CONFIG_FILE, ConfigError};
pub use prefs::{AgentPrefs, UpdaterPrefs};
pub use vaults::{
    AccountBinding, GetVaultsResponse, RegistryError, SandboxInfo, StoredVault, VaultInfo,
    VaultRegistry,
};
