//! Calendar providers on the native app (#3546): the shell side of each provider, which owns the
//! helper processes, HTTP and the keychain while the core owns the calendar model.
//!
//! 29d: the per-provider credentials ([`credentials`]), the subscribed-feed fetch
//! ([`ics_fetch`]) and its service over the open vault ([`feeds`]), and the session-owned runner
//! that refreshes due feeds ([`runner`]). The core parses, expands and mirrors
//! (`VaultCalendar::feed_*`); this module owns HTTP, the keychain and scheduling, as the core's
//! provider API asks of a shell.
//!
//! 29e: the CalDAV connect flow ([`caldav_accounts`] over discovery, the transport and the writer
//! check), with the provider status every mutation answers ([`provider_status`]).

pub mod caldav_accounts;
pub mod caldav_digest;
pub mod caldav_discover;
pub mod caldav_transport;
mod caldav_xml;
pub mod credentials;
pub mod eventkit;
pub mod feeds;
pub mod ics_fetch;
pub mod provider_status;
pub mod runner;
pub mod writer_compat;
mod zones;
