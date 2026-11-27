//! How deep nested input may get before the seed stops recursing.

use super::Unsupported;

/// How deep a toggle, a list item or inline markup may nest before the seed
/// keeps its lines as written. The parse recurses once per level, and the
/// blocks it builds are walked and dropped the same way, so a pasted text of
/// a few thousand levels must not decide how much stack it gets.
pub(super) const MAX_NESTING: usize = 100;

/// The reason a text nested past [`MAX_NESTING`] is kept as written.
pub(super) const TOO_DEEP: Unsupported = Unsupported("nesting too deep");
