//! Narrow JSON HTTP client used by M4 auth/devices/linking flows.
//!
//! `http.rs` exposes the bare `post_json` / `get_json` / `delete_json` /
//! `patch_json` primitives, plus a `resolve_base_url` helper that reads
//! `SYNC_SERVER_URL` per call. The `*_with_base` variants accept an
//! explicit base URL and exist primarily to keep tests parallel-safe.
//!
//! `auth_client.rs` adds tiny route wrappers for the auth, device, and
//! linking endpoints declared in the M4 plan. They centralise the path
//! strings so call sites cannot drift.
//!
//! Out of scope for M4: retry orchestration, websocket, push/pull,
//! offline queueing. M6 owns those concerns.

pub mod auth_client;
pub mod http;
