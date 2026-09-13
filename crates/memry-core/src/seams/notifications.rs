//! The local-notification seam, FR-061.
//!
//! Reminders are scheduled **locally**, from the `local_notifications` table the
//! core owns. Nothing about a reminder reaches the server, and no push
//! certificate is involved, so a reminder keeps working with sync switched off.

use crate::api::errors::NotificationError;

/// One scheduled local notification.
///
/// `fire_at_epoch_ms` is an instant the core orders by, so it is an integer
/// rather than a wire-shaped string (data-model §A.6).
#[derive(Debug, Clone, uniffi::Record)]
pub struct LocalNotification {
    pub id: String,
    pub title: String,
    pub body: String,
    pub fire_at_epoch_ms: i64,
    /// Routes the tap. Opaque to the shell, which MUST hand it back unchanged.
    pub deep_link: String,
}

/// What the user has actually granted. Three states, not a boolean: `NotAsked`
/// and `Denied` call for completely different UI, and collapsing them produces
/// an app that keeps asking a user who already said no.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum NotificationPermission {
    NotAsked,
    Granted,
    Denied,
}

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait Notifications: Send + Sync {
    async fn permission(&self) -> NotificationPermission;
    async fn request_permission(&self) -> NotificationPermission;
    async fn schedule(&self, notification: LocalNotification) -> Result<(), NotificationError>;
    async fn cancel(&self, id: String) -> Result<(), NotificationError>;
    /// The ids the platform currently holds, so the core can reconcile after a
    /// restore or an out-of-band cancellation rather than trusting its own table.
    async fn pending_ids(&self) -> Result<Vec<String>, NotificationError>;
}
