//! The OS key source and keytar reader of the host.

#[cfg(target_os = "linux")]
pub use super::linux::{OsKeySource, OsKeytar};
#[cfg(target_os = "macos")]
pub use super::macos::{OsKeySource, OsKeytar};
#[cfg(windows)]
pub use super::windows::{OsKeySource, OsKeytar};
