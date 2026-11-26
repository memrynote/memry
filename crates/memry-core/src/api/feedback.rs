//! `POST /feedback`, the in-app feedback route desktop already uses
//! (`apps/sync-server/src/routes/feedback.ts`).
//!
//! The shell builds the JSON against `FeedbackSubmitSchema` in
//! `packages/contracts/src/feedback-api.ts`, the same way it builds a telemetry
//! batch. The core only sends it, because the core owns the session's access
//! token and the shell must never hold one. The server reads the bearer to put
//! the verified account and plan on the email, and takes the feedback
//! anonymously when there is none, so a signed-out device sends the same call.

use crate::api::auth::AuthSession;
use crate::api::errors::ApiError;
use crate::protocol::http::{ApiRequest, Auth, RetryPolicy};

#[uniffi::export(async_runtime = "tokio")]
impl AuthSession {
    /// Sends one feedback submission, already serialised by the shell. Never
    /// retries on its own: a person is waiting on the answer, and sending
    /// twice would email twice.
    pub async fn send_feedback(&self, payload_json: Vec<u8>) -> Result<(), ApiError> {
        let request = ApiRequest::post("/feedback")
            .body(payload_json)
            .auth(Auth::Session)
            .retry(RetryPolicy::never());
        self.http().send(request).await.map(|_| ())
    }
}
