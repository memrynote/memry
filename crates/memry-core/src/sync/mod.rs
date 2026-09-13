//! The sync tier: the clock algebra, field merge, the pull loop and the
//! engine that serialises them.
//!
//! | Module            | Chapter                | What it owns                                     |
//! | ----------------- | ---------------------- | ------------------------------------------------ |
//! | [`clock`]         | 06 §6.1, §6.2, §6.6    | the vector-clock algebra and `_offline` rebinding |
//! | [`field_merge`]   | 06 §6.3 – §6.8         | the winner rule, the conflict set, the field lists |
//! | [`store`]         | 05 §5.11, §5.12        | the per-scope cursor and the tombstone            |
//! | [`pull`]          | 05                     | one page: refs, bodies, apply, advance            |
//! | [`apply`]         | 06 §6.8, 05 §5.12      | the apply step, and the one dispatch on item type |
//! | [`state`]         | data-model §C.3        | the states and the edges drawn between them       |
//! | [`engine`]        | data-model §C.3        | when each edge is taken, one pass at a time       |
//! | [`outbox`]        | data-model §A.2, §C.4  | the durable write queue, one transaction at a time |
//! | [`push`]          | 05 §5.6, 07 §7.2       | one wave: order, seal, send, ack                  |
//! | [`policy`]        | 11                     | the write gate and the entitlement, three states  |
//! | [`body_pull`]     | 07 §7.8 – §7.11        | the downward CRDT feed: bodies into `yjs_updates` |
//! | [`crdt_wire`]     | 07 §7.11               | that feed's wire shapes, read tolerantly          |
//! | [`bootstrap`]     | 10                     | the elevated window, and the silent fallback      |
//! | [`socket`]        | 09                     | the hint channel, which is never a data path      |
//! | [`first_sync`]    | §C.3, FR-028           | refs, then metadata, then bodies for the window   |
//! | [`first_sync_store`] | §A.2                | that run's two work lists and its two `meta` keys |
//!
//! **The core owns no networking.** Every call here goes out through
//! [`crate::protocol::http`], which goes out through the `Transport` seam
//! (Constitution I). There is no HTTP crate in this crate's dependency graph
//! and a reviewer should treat one appearing as a constitution violation
//! rather than a convenience.

pub mod apply;
pub mod body_pull;
pub mod bootstrap;
pub mod clock;
pub mod crdt_wire;
pub mod engine;
pub mod field_merge;
pub mod first_sync;
pub mod first_sync_store;
pub mod outbox;
pub mod policy;
pub mod pull;
pub mod push;
pub mod socket;
pub mod state;
pub mod store;
