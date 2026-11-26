//! The bearer and the per-request call context, the port of Electron's `agent/mcp/session.ts`.
//! The bearer is 32 random bytes as hex, minted per server start, rotated on request and never
//! persisted.

use std::sync::RwLock;

use axum::http::HeaderMap;
use memry_core::crypto::sodium::random_bytes;
use subtle::ConstantTimeEq;

pub struct Session {
    bearer: RwLock<String>,
}

impl Session {
    pub fn new() -> Self {
        Self {
            bearer: RwLock::new(mint()),
        }
    }

    pub fn token(&self) -> String {
        self.bearer
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn rotate(&self) -> String {
        let token = mint();
        *self
            .bearer
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = token.clone();
        token
    }

    /// Compares in constant time; only the length leaks, and it is fixed.
    pub fn verify(&self, candidate: Option<&str>) -> bool {
        let Some(candidate) = candidate else {
            return false;
        };
        let bearer = self
            .bearer
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        candidate.len() == bearer.len() && bool::from(candidate.as_bytes().ct_eq(bearer.as_bytes()))
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

fn mint() -> String {
    hex::encode(random_bytes(32))
}

/// Who is calling: the turn's write capability (`X-Memry-Turn`, unverified here; only the write
/// gate can tell whether it names a turn in flight) and the window (`X-Memry-Window`). Both are
/// opaque, and an external client sends neither.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallContext {
    pub write_grant: Option<String>,
    pub window: Option<String>,
}

impl CallContext {
    pub fn from_headers(headers: &HeaderMap) -> Self {
        let read = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        Self {
            write_grant: read("x-memry-turn"),
            window: read("x-memry-window"),
        }
    }
}
