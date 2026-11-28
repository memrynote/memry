//! The calendar (#3546): native events and the range projection over the core's
//! `VaultCalendar` ([`service`]), their IPC shapes ([`views`]) and the system time zone the
//! projection reads local days in ([`zone`]).

pub mod service;
pub mod views;
pub mod zone;
