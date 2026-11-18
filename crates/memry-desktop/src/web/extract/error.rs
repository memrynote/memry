//! Errors of the extraction port.

use crate::web::extract::markdown::turndown::parse::CapHit;

/// A failure that JavaScript would raise as an exception. The pipeline treats these as
/// Defuddle treats a thrown `Error`: a caller that catches it continues, anything else aborts.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExtractError {
    /// css-what or css-select rejected a selector, such as an unknown pseudo class. The message
    /// is the JS `Error.message`.
    #[error("selector error: {0}")]
    Selector(String),
    /// A DOM call linkedom answers with a thrown `Error`: inserting a node into itself,
    /// removing a node from a parent it does not have.
    #[error("dom error: {0}")]
    Dom(String),
    /// An exception of the JavaScript the extractors run, such as `RangeError: Invalid time
    /// value` from `toISOString()` or a `TypeError` on a value of an unexpected shape.
    #[error("js error: {0}")]
    Js(String),
    /// Departure: Turndown's parse of the page went past a cap of [`Caps::for_page`] (too deep,
    /// too many nodes, too slow). JS has no such bound; the extraction fails instead of running
    /// html5ever's quadratic cases on a hostile page.
    ///
    /// [`Caps::for_page`]: crate::web::extract::markdown::turndown::parse::Caps::for_page
    #[error("the page is too large to convert: {0:?}")]
    TooLarge(CapHit),
}
