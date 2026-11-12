//! `POST /telemetry/batch`, the product-telemetry route desktop already uses
//! (`apps/sync-server/src/routes/telemetry.ts`).
//!
//! The shell owns the batch: it builds the JSON against
//! `TelemetryBatchSchema` in `packages/contracts/src/telemetry-api.ts`, queues
//! it, and decides when to flush. The core only sends it, because the core owns
//! the session's access token and the shell must never hold one. The server
//! reads the bearer to attribute the batch to an account hash, and reports it
//! anonymously when there is none, so a signed-out device sends the same call.

use crate::api::auth::AuthSession;
use crate::api::errors::{ApiError, TransportError};
use crate::protocol::http::{ApiRequest, Auth, RetryPolicy};

/// What the shell does with a batch after one send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum TelemetryDelivery {
    /// The server took it. Drop it from the queue.
    Accepted,
    /// The server refused this batch and will refuse it again, such as a 400
    /// from a server on older contracts. Drop it: keeping it would block every
    /// batch queued behind it.
    Rejected,
    /// No answer, a rate limit, or a 5xx. Keep it and send it on a later flush.
    RetryLater,
}

#[uniffi::export(async_runtime = "tokio")]
impl AuthSession {
    /// Sends one telemetry batch, already serialised by the shell. Never
    /// retries on its own: the shell's flush timer is the retry.
    pub async fn send_telemetry(&self, batch_json: Vec<u8>) -> TelemetryDelivery {
        let request = ApiRequest::post("/telemetry/batch")
            .body(batch_json)
            .auth(Auth::Session)
            .retry(RetryPolicy::never());
        match self.http().send(request).await {
            Ok(_) => TelemetryDelivery::Accepted,
            Err(error) => delivery_for(&error),
        }
    }
}

fn delivery_for(error: &ApiError) -> TelemetryDelivery {
    match error {
        ApiError::Transport {
            source: TransportError::Tls { .. },
        }
        | ApiError::InvalidClientIdentity { .. } => TelemetryDelivery::Rejected,
        ApiError::Status { status, .. } if (400..500).contains(status) => {
            TelemetryDelivery::Rejected
        }
        // A 2xx whose body did not parse was still accepted.
        ApiError::MalformedResponse { .. } => TelemetryDelivery::Accepted,
        _ => TelemetryDelivery::RetryLater,
    }
}
