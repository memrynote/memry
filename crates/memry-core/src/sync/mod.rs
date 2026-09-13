//! The sync tier: the clock algebra, field merge, the pull loop and the
//! engine that serialises them.
//!
//! | Module            | Chapter                | What it owns                                     |
//! | ----------------- | ---------------------- | ------------------------------------------------ |
//! | [`clock`]         | 06 §6.1, §6.2, §6.6    | the vector-clock algebra and `_offline` rebinding |
//! | [`field_merge`]   | 06 §6.3 – §6.8         | the winner rule, the conflict set, the field lists |
//! | [`store`]         | 05 §5.11, §5.12        | the per-scope cursor and the tombstone            |
//! | [`pull`]          | 05                     | one page: refs, bodies, apply, advance            |
//! | [`state`]         | data-model §C.3        | the states and the edges drawn between them       |
//! | [`engine`]        | data-model §C.3        | when each edge is taken, one pass at a time       |
//!
//! **The core owns no networking.** Every call here goes out through
//! [`crate::protocol::http`], which goes out through the `Transport` seam
//! (Constitution I). There is no HTTP crate in this crate's dependency graph
//! and a reviewer should treat one appearing as a constitution violation
//! rather than a convenience.

pub mod clock;
pub mod engine;
pub mod field_merge;
pub mod pull;
pub mod state;
pub mod store;
