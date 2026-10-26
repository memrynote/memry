//! `Style.js`.

use std::cell::RefCell;
use std::rc::Rc;

use super::tree::Pairs;
use super::val::num_str;

/// Own properties some builders assign onto a Style object that they hand to a node as its
/// `style` (`new MathNode("mtd", [], [], style)` in array.js). Every holder of the same Style
/// object sees them, so the pairs live behind a shared reference.
pub type SharedStyle = Rc<RefCell<Pairs>>;

#[derive(Debug)]
pub struct Style {
    pub level: i32,
    pub color: Option<String>,
    pub font: String,
    pub font_family: String,
    pub font_size: f64,
    pub font_weight: String,
    pub font_shape: String,
    pub max_size: [f64; 2],
    pub extra: SharedStyle,
}

/// A derived Style is a new object: it starts without the properties assigned to its source.
impl Clone for Style {
    fn clone(&self) -> Style {
        Style {
            level: self.level,
            color: self.color.clone(),
            font: self.font.clone(),
            font_family: self.font_family.clone(),
            font_size: self.font_size,
            font_weight: self.font_weight.clone(),
            font_shape: self.font_shape.clone(),
            max_size: self.max_size,
            extra: SharedStyle::default(),
        }
    }
}

pub const DISPLAY: i32 = 0;
pub const TEXT: i32 = 1;

const SUB_OR_SUP_LEVEL: [i32; 4] = [2, 2, 3, 3];

impl Style {
    pub fn new(level: i32, max_size: [f64; 2]) -> Style {
        Style {
            level,
            color: None,
            font: String::new(),
            font_family: String::new(),
            font_size: 1.0,
            font_weight: String::new(),
            font_shape: String::new(),
            max_size,
            extra: SharedStyle::default(),
        }
    }

    /// The enumerable own properties of the Style object, as a `for...in` over it lists them.
    pub fn own_properties(&self) -> Pairs {
        let color = self
            .color
            .clone()
            .unwrap_or_else(|| "undefined".to_string());
        let mut pairs: Pairs = vec![
            ("level".into(), self.level.to_string()),
            ("color".into(), color),
            ("font".into(), self.font.clone()),
            ("fontFamily".into(), self.font_family.clone()),
            ("fontSize".into(), num_str(self.font_size)),
            ("fontWeight".into(), self.font_weight.clone()),
            ("fontShape".into(), self.font_shape.clone()),
            (
                "maxSize".into(),
                format!(
                    "{},{}",
                    num_str(self.max_size[0]),
                    num_str(self.max_size[1])
                ),
            ),
        ];
        pairs.extend(self.extra.borrow().iter().cloned());
        pairs
    }

    pub fn with_level(&self, n: i32) -> Style {
        Style {
            level: n,
            ..self.clone()
        }
    }

    pub fn increment_level(&self) -> Style {
        self.with_level((self.level + 1).min(3))
    }

    pub fn in_sub_or_sup(&self) -> Style {
        self.with_level(SUB_OR_SUP_LEVEL[self.level as usize])
    }

    pub fn with_color(&self, color: &str) -> Style {
        Style {
            color: Some(color.to_string()),
            ..self.clone()
        }
    }

    pub fn with_font(&self, font: &str) -> Style {
        Style {
            font: font.to_string(),
            ..self.clone()
        }
    }

    pub fn with_text_font_family(&self, family: &str) -> Style {
        Style {
            font_family: family.to_string(),
            font: String::new(),
            ..self.clone()
        }
    }

    pub fn with_font_size(&self, num: f64) -> Style {
        Style {
            font_size: num,
            ..self.clone()
        }
    }

    pub fn with_text_font_weight(&self, weight: &str) -> Style {
        Style {
            font_weight: weight.to_string(),
            font: String::new(),
            ..self.clone()
        }
    }

    pub fn with_text_font_shape(&self, shape: &str) -> Style {
        Style {
            font_shape: shape.to_string(),
            font: String::new(),
            ..self.clone()
        }
    }
}
