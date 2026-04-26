//! Auth-facing public types serialised across the IPC boundary.
//!
//! `AuthStateKind` is intentionally narrow - the four states are the only
//! values the renderer needs to render the unlock UI. `AuthStatus` is what
//! `auth_get_status` returns; secret material never appears here.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AuthStateKind {
    Locked,
    Unlocking,
    Unlocked,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub state: AuthStateKind,
    pub device_id: Option<String>,
    pub email: Option<String>,
    pub has_biometric: bool,
    pub remember_device: bool,
}
