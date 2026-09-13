//! The optical-capture seam, chapter 03.
//!
//! Device linking scans a QR code. The camera, the permission prompt and the
//! decoder are all the platform's; the core receives the decoded payload and
//! does every cryptographic thing with it (Constitution I).

use crate::api::errors::CaptureError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CapturePermission {
    NotAsked,
    Granted,
    Denied,
    /// Parental controls or an MDM profile. Distinct from `Denied` because the
    /// user cannot grant it from Settings, so telling them to go there is wrong.
    Restricted,
}

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait CodeCapture: Send + Sync {
    async fn permission(&self) -> CapturePermission;
    async fn request_permission(&self) -> CapturePermission;

    /// Starts capture and resolves with the first decoded payload, or an error
    /// if the user cancels. The decoded string is **not** validated here: it is
    /// a linking payload the core parses and authenticates.
    async fn scan(&self) -> Result<String, CaptureError>;

    fn cancel(&self);
}
