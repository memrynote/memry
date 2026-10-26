//! The converters `math.full.js` calls: `MathMLToLaTeX.convert` (mathml-to-latex 1.8.0, in
//! `mathml`) and `temml.renderToString` (temml 0.13.3, not ported yet).
//!
//! `temml_render` returns the error a throwing converter raises, so its caller takes the same
//! `catch` branch as Defuddle does when temml throws: LaTeX-only elements keep their LaTeX as
//! text. The oracle (`packages/article-extract/scripts/vectors/standardize.mjs`,
//! `withDeferredRulesOff`) makes temml throw too, so the vectors hold exactly this behavior.
//! Delete the patch and this body when the temml port lands.

use crate::web::extract::error::ExtractError;

/// `MathMLToLaTeX.convert(mathml)`.
pub fn mathml_to_latex(mathml: &str) -> Result<String, ExtractError> {
    super::mathml::convert(mathml).map_err(ExtractError::Dom)
}

/// `temml.renderToString(latex, { displayMode, throwOnError: false })`.
pub fn temml_render(_latex: &str, _display_mode: bool) -> Result<String, ExtractError> {
    Err(ExtractError::Dom("temml is not ported".to_string()))
}
