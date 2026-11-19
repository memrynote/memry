//! Desktop attachment sync, chapter 14 (#3535). Desktop attachments are vault
//! files; this module decides which of them go to the server, which references
//! a note keeps, and when a deleted item's chunks are freed, and moves their
//! bytes: [`transfer::AttachmentTransfer`] uploads ([`upload`]) and downloads
//! ([`download`]) one file at a time, and [`records`] writes what a finished
//! transfer leaves behind. The runners drive them: [`queue`] (downloads and
//! the upload drain), [`backfill`], [`revival`] and [`release`].

#[cfg(feature = "markdown")]
pub mod backfill;
pub mod download;
pub mod holds;
pub mod plan;
pub mod presign;
pub mod queue;
pub mod records;
pub mod release;
pub mod resume;
pub mod revival;
pub mod server;
pub mod store;
pub mod transfer;
pub mod upload;
