//! `Style.js`.

#[derive(Clone, Debug)]
pub struct Style {
    pub level: i32,
    pub color: Option<String>,
    pub font: String,
    pub font_family: String,
    pub font_size: f64,
    pub font_weight: String,
    pub font_shape: String,
    pub max_size: [f64; 2],
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
        }
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
