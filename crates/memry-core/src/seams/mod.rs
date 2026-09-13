//! The eight foreign traits the shell fills in, data-model §D.7.
//!
//! **The list is closed.** Adding a ninth requires a written justification in
//! the specification, because every seam is a place a shell can grow logic the
//! core was supposed to own (Constitution I, FR-017).
//!
//! | Seam             | What only the platform can do                        |
//! | ---------------- | ---------------------------------------------------- |
//! | `SecureStore`    | Keychain, with the core's access-control policy      |
//! | `FileProtection` | data-protection class and backup exclusion           |
//! | `Notifications`  | local notification scheduling and permission         |
//! | `BackgroundExec` | background task registration and expiry warnings     |
//! | `Reachability`   | network reachability transitions                     |
//! | `Transport`      | HTTP and the realtime socket                         |
//! | `EditorHost`     | the WebView bridge relay                             |
//! | `CodeCapture`    | optical code capture                                 |
//!
//! Everything else — merge, clocks, crypto, retry, cursors, schema — is the
//! core's, and a seam that starts carrying one of those is the bug this list
//! exists to make visible.

pub mod background;
pub mod capture;
pub mod editor;
pub mod notifications;
pub mod reachability;
pub mod secure_store;
pub mod storage;
pub mod transport;
