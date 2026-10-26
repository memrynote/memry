//! Port of `packages/shared/src/critic-markup` (`parser.ts`, `transforms.ts`).
//! `yjs.ts` touches a Y.Doc and belongs to stage 6.
//!
//! Mark offsets are UTF-16 code-unit offsets into the plain text, as in the
//! TypeScript; [`units`] holds the JavaScript string semantics they need.

mod comment;
mod format;
mod parse;
mod scan;
mod transforms;
mod types;
pub mod units;
pub(crate) mod uri;

pub use comment::build_comment_payload;
pub use format::{
    critic_markup_comment_body_hash, normalize_critic_markup_comment_attachments,
    normalize_critic_markup_comment_format_ranges, normalize_critic_markup_comment_mentions,
    parse_critic_markup_comment_format,
};
pub use parse::{parse_critic_markup, serialize_critic_markup, serialize_critic_markup_units};
pub use transforms::{
    TransformResult, accept_critic_mark, delete_critic_mark, reject_critic_mark,
    resolve_critic_mark,
};
pub use types::*;
