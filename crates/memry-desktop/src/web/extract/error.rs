//! Errors of the extraction port.

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
}
