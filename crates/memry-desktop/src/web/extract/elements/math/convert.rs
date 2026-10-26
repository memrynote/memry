//! The converters `math.full.js` calls: `MathMLToLaTeX.convert` (mathml-to-latex 1.8.0) and
//! `temml.renderToString` (temml 0.13.3).
//!
//! Neither is ported yet. Each returns the error a throwing converter raises, so the callers
//! take the same `catch` branches as Defuddle does when the converter throws: the LaTeX stays
//! unknown for MathML-only elements, and LaTeX-only elements keep their LaTeX as text. The
//! oracle (`packages/article-extract/scripts/vectors/standardize.mjs`, `withDeferredRulesOff`)
//! makes both converters throw, so the vectors hold exactly this behavior. Delete the patch and
//! these bodies when the ports land.

use crate::web::extract::error::ExtractError;

/// `MathMLToLaTeX.convert(mathml)`.
pub fn mathml_to_latex(_mathml: &str) -> Result<String, ExtractError> {
    Err(ExtractError::Dom(
        "mathml-to-latex is not ported".to_string(),
    ))
}

/// `temml.renderToString(latex, { displayMode, throwOnError: false })`.
pub fn temml_render(_latex: &str, _display_mode: bool) -> Result<String, ExtractError> {
    Err(ExtractError::Dom("temml is not ported".to_string()))
}
