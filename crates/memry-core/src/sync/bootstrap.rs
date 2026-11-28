//! The bootstrap session client, chapter 10.
//!
//! A bootstrap session is an **elevated-throughput window** a fresh device
//! opens while it pulls a whole vault for the first time (§10.1). It carries
//! no data the ordinary endpoints do not, changes nothing about the pull
//! shape, and only ever widens rate ceilings (§10.7).
//!
//! Everything in this file follows from one sentence, §10.5's fallback rule:
//!
//! > a client treats **any** open failure — including a `404` from a server
//! > that does not mount these routes — as "no bootstrap" and falls back
//! > silently to steady-state pacing.
//!
//! So [`BootstrapClient::open`] **returns no error**. There is nothing a
//! caller could usefully do with one: it must not be surfaced, must not be
//! retried beyond the ordinary transport ladder, and must not block the first
//! sync. A `501 BOOTSTRAP_UNAVAILABLE` is the same non-event as the rest —
//! §10.12 says the deployment simply has no HMAC key, which is a deployment
//! configuration fact and **not a client bug**. The HTTP client already keeps
//! it out of the retryable-5xx branch ([`ApiError::BootstrapUnavailable`]),
//! because a ladder spent on a condition that cannot change inside a
//! deployment is a ladder wasted.
//!
//! Three rules are easy to implement wrongly, and Q10.2 (§10.11) is the one
//! that actually bites on a large vault:
//!
//! - **Renew at the lead, not at the expiry.** [`BOOTSTRAP_RENEW_LEAD_SECONDS`]
//!   before `expiresAt`, so a renewal that has to retry still lands.
//! - **Any renewal failure drops the header and continues.** The session's
//!   absolute lifetime is six hours (§10.10) and a first sync that outlives it
//!   gets `403 BOOTSTRAP_SESSION_EXPIRED` on renewal. That is **an ordinary
//!   rate change, not an error**: no reset, no restart, no failure reported.
//! - **Never open a second session.** The window is one-shot per device per
//!   vault by design (§10.9), so an expired one cannot be replaced and a
//!   second attempt can only earn a `409 BOOTSTRAP_NOT_ELIGIBLE`.
//!
//! Progress reporting survives all of it, because progress is measured against
//! `tailCursor` and the client's own cursor (§10.4), neither of which the
//! session affects.

use std::sync::{Arc, Mutex};

use serde_json::{Value as Json, json};

use crate::protocol::http::{
    ApiRequest, Auth, BOOTSTRAP_TOKEN_HEADER, HttpClient, RetryPolicy, VAULT_ID_HEADER,
};

/// §10.10, `BOOTSTRAP_SESSION_TTL_SECONDS`. The token's own life, renewable.
pub const BOOTSTRAP_SESSION_TTL_SECONDS: i64 = 3_600;
/// §10.10, `BOOTSTRAP_RENEW_LEAD_SECONDS`.
pub const BOOTSTRAP_RENEW_LEAD_SECONDS: i64 = 300;
/// §10.10, `MAX_BOOTSTRAP_SESSION_LIFETIME_SECONDS`. Six hours, **not**
/// renewable: this is where Q10.2's mid-run fallback happens.
pub const MAX_BOOTSTRAP_SESSION_LIFETIME_SECONDS: i64 = 21_600;

/// A live session's token and the instant it stops being honoured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapSession {
    /// Sent in `X-Memry-Bootstrap-Token` **verbatim** (§10.3).
    pub token: String,
    /// Epoch **seconds** (§10.4).
    pub expires_at: i64,
}

impl BootstrapSession {
    /// §10.11 rule 1: renew proactively, at the lead rather than at the
    /// expiry.
    pub fn renew_due(&self, now_s: i64) -> bool {
        now_s >= self.expires_at - BOOTSTRAP_RENEW_LEAD_SECONDS
    }

    pub fn expired(&self, now_s: i64) -> bool {
        now_s >= self.expires_at
    }
}

/// What `POST /sync/bootstrap` told the client, reduced to the two things a
/// first sync uses.
///
/// The manifest's first page, `attachments` and `packs` are deliberately not
/// here. §10.4 says the manifest is **never the whole vault**, that
/// `attachments.chunkHashes` is **not a complete inventory** and that
/// `packs: []` does **not** mean the vault has no packs — so a first sync that
/// treated any of them as authoritative would be wrong, and a field nobody may
/// trust is a field better not offered.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BootstrapOpen {
    /// `None` when the open failed for any reason at all (§10.5).
    pub session: Option<BootstrapSession>,
    /// `MAX(server_cursor)` at open, so the client can tell when its pull has
    /// caught up (§10.4). `0` when there were no rows, or when the open
    /// failed — an unknown tail is reported as "nothing known", never as an
    /// error.
    pub tail_cursor: i64,
    /// Why there is no session, for a log line. **Never shown to a user**
    /// (§10.5) and never a reason to retry.
    pub fallback_reason: Option<String>,
}

impl BootstrapOpen {
    pub fn elevated(&self) -> bool {
        self.session.is_some()
    }
}

/// Where the client is in the session's life. Named so a shell can explain the
/// pacing rather than guess at it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// No open has been attempted yet.
    Unopened,
    /// A token is held and elevation is in force.
    Elevated,
    /// The window is over — it failed to open, the renewal failed, or the six
    /// hours of §10.10 are spent. Steady-state pacing, and **no second
    /// session is ever opened** (§10.11 rule 3).
    SteadyState,
}

/// The session client. One per vault, held for the length of a first sync.
pub struct BootstrapClient {
    http: Arc<HttpClient>,
    vault_id: Option<String>,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    session: Option<BootstrapSession>,
    /// §10.11 rule 3's latch. Set by the first `open`, never cleared.
    opened_once: bool,
    /// Set the moment the window ends, for whatever reason.
    finished: bool,
}

impl BootstrapClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self {
            http,
            vault_id: None,
            inner: Mutex::new(Inner::default()),
        }
    }

    pub fn with_vault(mut self, vault_id: &str) -> Self {
        self.vault_id = Some(vault_id.to_owned());
        self
    }

    pub fn state(&self) -> SessionState {
        let inner = self.lock();
        match (&inner.session, inner.opened_once) {
            (Some(_), _) => SessionState::Elevated,
            (None, false) => SessionState::Unopened,
            (None, true) => SessionState::SteadyState,
        }
    }

    /// The token held right now, if the window is still open.
    pub fn session(&self) -> Option<BootstrapSession> {
        self.lock().session.clone()
    }

    /// Opens the window. **Cannot fail** (§10.5), and cannot be called twice
    /// to any effect (§10.11 rule 3).
    pub async fn open(&self, now_s: i64) -> BootstrapOpen {
        if self.lock().opened_once {
            return BootstrapOpen {
                session: None,
                tail_cursor: 0,
                fallback_reason: Some(
                    "the bootstrap window is one-shot per device per vault (§10.9)".to_owned(),
                ),
            };
        }
        self.lock().opened_once = true;

        let request = self
            .request("POST", "/sync/bootstrap")
            // §10.5: no retry beyond the ordinary transport ladder. A 429 here
            // is `BOOTSTRAP_SESSION_LIMIT`, which is the concurrency cap and
            // will not clear inside one ladder.
            .retry(RetryPolicy::polled())
            .json(&json!({}));

        let body: Json = match self.http.send_json(request).await {
            Ok(body) => body,
            Err(error) => {
                self.lock().finished = true;
                return BootstrapOpen {
                    session: None,
                    tail_cursor: 0,
                    // §10.12: a 501 lands here like everything else. It is a
                    // deployment gap and this string is the whole of the
                    // client's reaction to it.
                    fallback_reason: Some(error.to_string()),
                };
            }
        };

        let tail_cursor = read_tail_cursor(&body);
        let Some(session) = read_session(&body, now_s) else {
            self.lock().finished = true;
            return BootstrapOpen {
                session: None,
                tail_cursor,
                fallback_reason: Some("the open response carried no session token".to_owned()),
            };
        };

        self.lock().session = Some(session.clone());
        BootstrapOpen {
            session: Some(session),
            tail_cursor,
            fallback_reason: None,
        }
    }

    /// §10.11's transition, run before each elevated request or on a timer.
    ///
    /// Renews when the lead has been reached, and on **any** failure drops the
    /// token and continues at steady-state pacing. Returns whether elevation
    /// is still in force afterwards.
    pub async fn renew_if_due(&self, now_s: i64) -> bool {
        let Some(session) = self.session() else {
            return false;
        };
        if !session.renew_due(now_s) {
            return true;
        }

        let request = self
            .request("POST", "/sync/bootstrap/renew")
            .retry(RetryPolicy::polled())
            .json(&json!({}));

        match self.http.send_json::<Json>(request).await {
            Ok(body) => match read_session(&body, now_s) {
                Some(renewed) => {
                    self.lock().session = Some(renewed);
                    true
                }
                None => {
                    self.fall_back();
                    false
                }
            },
            // §10.11 rule 2: **any** renewal failure. `403
            // BOOTSTRAP_SESSION_EXPIRED` — the six-hour absolute lifetime
            // spent mid-run — is the expected one and is not distinguished,
            // because the reaction is identical for all of them.
            Err(_) => {
                self.fall_back();
                false
            }
        }
    }

    /// The header to add to an elevated request, or `None` at steady state.
    ///
    /// §10.7: every elevated bucket is pull-only, so this belongs on
    /// `/sync/changes`, `/sync/pull`, `/sync/manifest` and the CRDT pull
    /// routes, and **not** on `/sync/push`.
    pub fn header(&self, now_s: i64) -> Option<(&'static str, String)> {
        let mut inner = self.lock();
        let session = inner.session.as_ref()?;
        if session.expired(now_s) {
            // A dead token elevates nothing and is not worth a round trip to
            // discover; dropping it locally is §10.5's fallback taken early.
            inner.session = None;
            inner.finished = true;
            return None;
        }
        Some((BOOTSTRAP_TOKEN_HEADER, session.token.clone()))
    }

    /// Adds the header when the window is open. The one call site a caller
    /// needs; forgetting it costs throughput and nothing else.
    pub fn elevate(&self, request: ApiRequest, now_s: i64) -> ApiRequest {
        match self.header(now_s) {
            Some((name, value)) => request.header(name, &value),
            None => request,
        }
    }

    /// `POST /sync/bootstrap/close`, which §10.2 says is **idempotent**.
    ///
    /// Best effort and deliberately unexamined: §10.8 records that elevation
    /// is stateless, so a closed session's token keeps elevating from its own
    /// device until its `exp` regardless. Closing is a courtesy to the
    /// concurrency cap, not a security boundary.
    pub async fn close(&self) {
        if self.lock().session.take().is_none() {
            return;
        }
        self.lock().finished = true;
        let request = self
            .request("POST", "/sync/bootstrap/close")
            .retry(RetryPolicy::never())
            .json(&json!({}));
        let _ = self.http.send_json::<Json>(request).await;
    }

    fn fall_back(&self) {
        let mut inner = self.lock();
        inner.session = None;
        inner.finished = true;
    }

    fn request(&self, method: &str, path: &str) -> ApiRequest {
        let mut request = ApiRequest::new(method, path).auth(Auth::Session);
        if let Some(vault_id) = &self.vault_id {
            request = request.header(VAULT_ID_HEADER, vault_id);
        }
        request
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// §10.4's `session` object. `ttlSeconds` mirrors `exp - iat`, so a response
/// that carried only it still names an expiry.
fn read_session(body: &Json, now_s: i64) -> Option<BootstrapSession> {
    let session = body.get("session")?;
    let token = session.get("token").and_then(Json::as_str)?.to_owned();
    if token.is_empty() {
        return None;
    }
    let expires_at = session
        .get("expiresAt")
        .and_then(Json::as_i64)
        .or_else(|| {
            session
                .get("ttlSeconds")
                .and_then(Json::as_i64)
                .map(|ttl| now_s + ttl)
        })
        .unwrap_or(now_s + BOOTSTRAP_SESSION_TTL_SECONDS);
    Some(BootstrapSession { token, expires_at })
}

/// §10.4: absent rows give `0`, and an absent field means the same thing.
fn read_tail_cursor(body: &Json) -> i64 {
    match body.get("tailCursor") {
        Some(Json::Number(number)) => number.as_i64().unwrap_or(0),
        // The record cursor is a decimal string on the wire elsewhere
        // (chapter 05 §5.11); a server that spells the tail the same way means
        // the same number.
        Some(Json::String(text)) => text.parse().unwrap_or(0),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_constants_are_the_chapter_table() {
        assert_eq!(BOOTSTRAP_SESSION_TTL_SECONDS, 3_600);
        assert_eq!(BOOTSTRAP_RENEW_LEAD_SECONDS, 300);
        assert_eq!(MAX_BOOTSTRAP_SESSION_LIFETIME_SECONDS, 21_600);
    }

    #[test]
    fn renewal_is_due_a_whole_lead_before_the_expiry() {
        let session = BootstrapSession {
            token: "t".into(),
            expires_at: 10_000,
        };
        assert!(!session.renew_due(10_000 - BOOTSTRAP_RENEW_LEAD_SECONDS - 1));
        assert!(session.renew_due(10_000 - BOOTSTRAP_RENEW_LEAD_SECONDS));
        assert!(session.renew_due(9_999));
        assert!(!session.expired(9_999));
        assert!(session.expired(10_000));
    }

    #[test]
    fn a_session_without_an_expiry_falls_back_to_the_ttl() {
        let from_ttl = read_session(&json!({"session":{"token":"t","ttlSeconds":600}}), 1_000);
        assert_eq!(from_ttl.map(|s| s.expires_at), Some(1_600));

        let neither = read_session(&json!({"session":{"token":"t"}}), 1_000);
        assert_eq!(
            neither.map(|s| s.expires_at),
            Some(1_000 + BOOTSTRAP_SESSION_TTL_SECONDS)
        );

        assert_eq!(read_session(&json!({"session":{"token":""}}), 0), None);
        assert_eq!(read_session(&json!({}), 0), None);
    }

    #[test]
    fn an_absent_tail_cursor_reads_as_zero_rather_than_as_a_failure() {
        assert_eq!(read_tail_cursor(&json!({"tailCursor": 41})), 41);
        assert_eq!(read_tail_cursor(&json!({"tailCursor": "41"})), 41);
        assert_eq!(read_tail_cursor(&json!({})), 0);
    }
}
