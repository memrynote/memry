//! A port of temml 0.13.3 `renderToString`, MathML output only.
//!
//! Defuddle (`math.full.js`) calls `temml.renderToString(latex, { displayMode, throwOnError:
//! false })` and reads the `<math>` element of the result. When temml reports an error it renders
//! the LaTeX plus the message in a `<span class="temml-error">`, which holds no `<math>`, so the
//! caller keeps the LaTeX as text. The port returns `Err` for every case where temml throws or
//! renders that span: the message text is not reproduced, as nothing reads it.

mod build;
mod functions;
mod lexer;
mod linebreak;
mod macro_expander;
mod macros;
mod parser;
mod parser_args;
mod replace;
mod settings;
mod stretchy;
mod style;
mod tables;
mod tree;
mod units;
mod val;
mod variant;

use std::rc::Rc;

use settings::Settings;
use style::{DISPLAY, Style, TEXT};

/// `temml.renderToString(latex, { displayMode, throwOnError: false })` as markup, or `Err` when
/// temml renders its error span (or throws).
pub fn render_to_string(latex: &str, display_mode: bool) -> Result<String, String> {
    let settings = Rc::new(Settings::new(display_mode));
    let run = || -> val::R<String> {
        let tree = parser::parse_tree(latex, &settings)?;
        let style = Style::new(
            if settings.display_mode { DISPLAY } else { TEXT },
            [f64::INFINITY, f64::INFINITY],
        );
        Ok(build::build_mathml(tree, &style, &settings)?.to_markup())
    };
    run().map_err(|e| e.message)
}
