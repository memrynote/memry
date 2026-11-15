//! The access token for a desktop request the core does not make itself:
//! feedback and the iPhone beta invite carry it when the user is signed in
//! (Electron: `getValidAccessToken`, `ipc/feedback-handlers.ts:23-27`).

use std::time::{SystemTime, UNIX_EPOCH};

use crate::api::errors::AuthError;
use crate::protocol::auth::TokenClaims;

use super::AuthSession;

impl AuthSession {
    /// The stored access token, refreshed first when it has expired; `None`
    /// with no session. Rust-only: a token never crosses the FFI.
    pub async fn valid_access_token(&self) -> Result<Option<String>, AuthError> {
        let Some(token) = self.tokens.access_token_sync()? else {
            return Ok(None);
        };
        let now_s = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        if !TokenClaims::parse(&token)?.is_expired(now_s) {
            return Ok(Some(token));
        }
        self.tokens.refresh(Some(&token)).await.map(Some)
    }
}
