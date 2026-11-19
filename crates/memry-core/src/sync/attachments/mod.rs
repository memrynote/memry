//! Desktop attachment sync, chapter 14 (#3535). Desktop attachments are vault
//! files; this module decides which of them go to the server, which references
//! a note keeps, and when a deleted item's chunks are freed.

pub mod holds;
pub mod plan;
pub mod store;
