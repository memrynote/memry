//! `element.style` as jsdom's cssstyle shows it to the parse rules: declarations
//! of the `style` attribute by property name. Only what the rules read is
//! normalised (colours); the property names are case-insensitive.

#[derive(Debug, Default, Clone)]
pub struct Style {
    declarations: Vec<(String, String)>,
}

impl Style {
    pub fn parse(text: &str) -> Style {
        let mut declarations: Vec<(String, String)> = Vec::new();
        for part in split_declarations(text) {
            let Some((name, value)) = part.split_once(':') else {
                continue;
            };
            let name = name.trim().to_ascii_lowercase();
            let mut value = value.trim();
            if let Some(stripped) = value
                .strip_suffix("!important")
                .or_else(|| value.strip_suffix("! important"))
            {
                value = stripped.trim_end();
            }
            if name.is_empty() || value.is_empty() {
                continue;
            }
            let value = match name.as_str() {
                "color" | "background-color" => match normalize_color(value) {
                    Some(color) => color,
                    None => continue,
                },
                _ => value.to_owned(),
            };
            match declarations.iter_mut().find(|(n, _)| *n == name) {
                Some((_, v)) => *v = value,
                None => declarations.push((name, value)),
            }
        }
        Style { declarations }
    }

    /// `style.length`.
    pub fn len(&self) -> usize {
        self.declarations.len()
    }

    pub fn is_empty(&self) -> bool {
        self.declarations.is_empty()
    }

    /// `style.getPropertyValue(name)`: the empty string for an unset property.
    pub fn get(&self, name: &str) -> &str {
        self.declarations
            .iter()
            .find(|(n, _)| n == name)
            .map_or("", |(_, v)| v.as_str())
    }
}

/// Splits on `;` outside parentheses and quotes.
fn split_declarations(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut depth, mut quote, mut start) = (0usize, None::<char>, 0usize);
    for (i, c) in text.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '(') => depth += 1,
            (None, ')') => depth = depth.saturating_sub(1),
            (None, ';') if depth == 0 => {
                parts.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

/// cssstyle keeps a colour keyword or function as written (lower-cased) and
/// writes a hex colour as `rgb(r, g, b)`; an unparsable value is dropped.
fn normalize_color(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    if let Some(hex) = lower.strip_prefix('#') {
        if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let digits: Vec<u32> = hex.chars().filter_map(|c| c.to_digit(16)).collect();
        return match digits.len() {
            3 => Some(format!(
                "rgb({}, {}, {})",
                digits[0] * 17,
                digits[1] * 17,
                digits[2] * 17
            )),
            6 => Some(format!(
                "rgb({}, {}, {})",
                digits[0] * 16 + digits[1],
                digits[2] * 16 + digits[3],
                digits[4] * 16 + digits[5]
            )),
            _ => None,
        };
    }
    Some(lower)
}
