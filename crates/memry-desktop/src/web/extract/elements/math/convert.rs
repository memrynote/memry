//! The converters `math.full.js` calls: `MathMLToLaTeX.convert` (mathml-to-latex 1.8.0, in
//! `mathml`) and `temml.renderToString` (temml 0.13.3, in `temml`).

use crate::web::extract::error::ExtractError;

/// `MathMLToLaTeX.convert(mathml)`.
pub fn mathml_to_latex(mathml: &str) -> Result<String, ExtractError> {
    super::mathml::convert(mathml).map_err(ExtractError::Dom)
}

/// `temml.renderToString(latex, { displayMode, throwOnError: false })`.
///
/// An `Err` is a throw or temml's error span, which holds no `<math>`: the caller keeps the
/// LaTeX as text either way.
pub fn temml_render(latex: &str, display_mode: bool) -> Result<String, ExtractError> {
    super::temml::render_to_string(latex, display_mode).map_err(ExtractError::Dom)
}
