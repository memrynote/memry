//! Journal day writes and reads for the shells (spec 005-journal Phase 2).
//!
//! A day is addressed by its calendar date. Every write resolves the record id
//! through [`crate::domain::journal::entry_for`] (an existing id wins, D5) and
//! creates or revives the day on its **first** write, never on navigation
//! (D2), inside the write's own transaction
//! ([`crate::domain::journal::open_day_in`]).

pub mod body;
pub mod links;
pub mod metadata;
pub mod reads;
pub mod seed;
pub mod settings;
