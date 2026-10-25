//! Port of `dist/constants.js` (Defuddle 0.19.0). The tables keep their JS order, which decides
//! the first match; `tests/article_constants.rs` compares each one with the module's exports.

mod attributes;
mod partial;
mod patterns;
mod selectors;
mod tags;

pub use attributes::*;
pub use partial::{partial_selectors_anchored_match, partial_selectors_match};
pub use patterns::PARTIAL_SELECTORS;
pub use selectors::*;
pub use tags::*;
