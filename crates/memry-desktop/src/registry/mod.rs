//! The app config file and the vault registry kept in it.

pub mod config;
pub mod create;
pub mod vault_icon;
pub mod vaults;

pub use config::{AppConfig, ConfigError};
pub use vaults::{
    AccountBinding, GetVaultsResponse, RegistryError, SandboxInfo, StoredVault, VaultInfo,
    VaultRegistry,
};
