//! The option flags of `Defuddle.parseInternal` (`dist/defuddle.js:699-715`) that gate the
//! removal steps. `debug` is always off in the port, so no step records removals.

/// Every flag defaults to true, as `parseInternal` spreads them before the caller's options.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settings {
    pub remove_exact_selectors: bool,
    pub remove_partial_selectors: bool,
    pub remove_hidden_elements: bool,
    pub remove_low_scoring: bool,
    pub remove_small_images: bool,
    pub remove_content_patterns: bool,
    pub standardize: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            remove_exact_selectors: true,
            remove_partial_selectors: true,
            remove_hidden_elements: true,
            remove_low_scoring: true,
            remove_small_images: true,
            remove_content_patterns: true,
            standardize: true,
        }
    }
}

impl Settings {
    /// The options of a retry that keeps hidden elements (`dist/defuddle.js:80`).
    pub fn keep_hidden(self) -> Self {
        Settings {
            remove_hidden_elements: false,
            ..self
        }
    }

    /// The options of the extractor pipeline run (`dist/defuddle.js:749-751`): hidden elements
    /// and low-scoring blocks stay.
    pub fn extractor_pipeline(self) -> Self {
        Settings {
            remove_low_scoring: false,
            remove_hidden_elements: false,
            ..self
        }
    }
}
