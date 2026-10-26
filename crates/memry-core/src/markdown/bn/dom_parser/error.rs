use crate::markdown::bn::html_tree::TreeError;
use crate::markdown::pm::PmError;

/// A conversion step the TypeScript would have thrown out of: the oracle records
/// `status: "error"` and the caller keeps the file.
#[derive(Debug, PartialEq, thiserror::Error)]
pub enum ParseError {
    #[error(transparent)]
    Pm(#[from] PmError),
    #[error(transparent)]
    Tree(#[from] TreeError),
    #[error("{0}")]
    Js(&'static str),
    /// Nested deeper than `limits::MAX_NESTING_DEPTH`: the TypeScript throws a `RangeError`.
    #[error("nesting too deep")]
    TooDeep,
}
