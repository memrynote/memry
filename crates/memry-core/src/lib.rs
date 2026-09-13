//! The Memry native core.
//!
//! One Rust library, every shell's only implementation of the sync protocol.
//! The specification it implements is `docs/protocol/00` through `14`; where
//! this crate and a chapter disagree, the chapter wins and the disagreement is
//! a bug here (spec.md, Constitution I).
//!
//! The core owns storage, crypto, sync and domain logic. It owns no UI, no
//! networking and no keychain: those cross the foreign-trait seams in `seams`,
//! which the shell fills in.

pub mod api;
pub mod crypto;
pub mod protocol;
pub mod seams;
pub mod storage;

uniffi::setup_scaffolding!();
