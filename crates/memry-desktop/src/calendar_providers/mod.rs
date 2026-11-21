//! Calendar providers on the native app (#3546): the shell side of each provider, which owns the
//! helper processes, HTTP and the keychain while the core owns the calendar model.
//!
//! 29d: the per-provider credentials ([`credentials`]), the subscribed-feed fetch
//! ([`ics_fetch`]) and its service over the open vault ([`feeds`]), and the session-owned runner
//! that refreshes due feeds ([`runner`]). The core parses, expands and mirrors
//! (`VaultCalendar::feed_*`); this module owns HTTP, the keychain and scheduling, as the core's
//! provider API asks of a shell.

pub mod credentials;
pub mod eventkit;
pub mod feeds;
pub mod ics_fetch;
pub mod runner;
mod zones;
