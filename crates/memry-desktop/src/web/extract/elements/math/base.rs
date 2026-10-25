//! `dist/elements/math.base.js`.

use std::sync::LazyLock;

use regex::Regex;

/// `LOOKS_LIKE_LATEX_RE`: a backslash command of two or more ASCII letters.
static LOOKS_LIKE_LATEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\[a-zA-Z]{2,}").expect("static pattern"));

/// `LOOKS_LIKE_LATEX_RE.test(text)`.
pub fn looks_like_latex(text: &str) -> bool {
    LOOKS_LIKE_LATEX.is_match(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latex_commands() {
        assert!(looks_like_latex(r"\alpha + \beta"));
        assert!(!looks_like_latex(r"\a"));
        assert!(!looks_like_latex("plain"));
    }
}
