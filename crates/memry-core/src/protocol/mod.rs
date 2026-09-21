//! Wire formats: the compression frame, the record envelope, and the HTTP
//! surface above them.

pub mod account;
pub mod attachment_manifest;
pub mod auth;
pub mod compress;
pub mod crdt_envelope;
pub mod envelope;
pub mod http;
pub mod linking;
pub mod pack;
pub mod types;
