//! `Settings.js`, with the options `renderToString` receives from Defuddle (`displayMode`,
//! `throwOnError: false`); every other option keeps temml's default.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use super::macro_expander::MacroDef;

pub struct Settings {
    pub display_mode: bool,
    pub throw_on_error: bool,
    pub error_color: String,
    pub macros: Rc<RefCell<HashMap<String, MacroDef>>>,
    pub strict: bool,
    pub max_expand: usize,
    pub wrap_delimiter_pairs: Cell<bool>,
}

impl Settings {
    pub fn new(display_mode: bool) -> Settings {
        Settings {
            display_mode,
            throw_on_error: false,
            error_color: "#b22222".to_string(),
            macros: Rc::new(RefCell::new(HashMap::new())),
            strict: false,
            max_expand: 1000,
            wrap_delimiter_pairs: Cell::new(true),
        }
    }
}
