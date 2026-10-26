//! The lookup tables of mathml-to-latex, generated into `tables.json` by
//! `packages/article-extract/scripts/vectors/mathml-tables.mjs`.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::Value;

pub struct Accent {
    pub vowel: String,
    pub accent: String,
}

pub struct SpecialFont {
    pub letter: String,
    pub command: String,
}

pub struct Tables {
    pub operators_by_char: HashMap<String, String>,
    pub operators_by_glyph: HashMap<String, String>,
    pub symbols_by_char: HashMap<String, String>,
    pub symbols_by_glyph: HashMap<String, String>,
    pub number_by_glyph: HashMap<String, String>,
    pub accent_command: HashMap<String, String>,
    pub vowels_with_accents: HashMap<String, Accent>,
    pub special_font_chars: HashMap<String, SpecialFont>,
}

fn entries(root: &Value, name: &str) -> Vec<(String, Value)> {
    root[name]
        .as_array()
        .unwrap_or_else(|| panic!("table {name} missing"))
        .iter()
        .map(|pair| {
            (
                pair[0].as_str().expect("table key").to_string(),
                pair[1].clone(),
            )
        })
        .collect()
}

fn strings(root: &Value, name: &str) -> HashMap<String, String> {
    entries(root, name)
        .into_iter()
        .map(|(k, v)| (k, v.as_str().expect("table value").to_string()))
        .collect()
}

pub static TABLES: LazyLock<Tables> = LazyLock::new(|| {
    let root: Value = serde_json::from_str(include_str!("tables.json")).expect("tables.json");
    let text = |v: &Value, key: &str| v[key].as_str().expect(key).to_string();
    Tables {
        operators_by_char: strings(&root, "allMathOperatorsByChar"),
        operators_by_glyph: strings(&root, "allMathOperatorsByGlyph"),
        symbols_by_char: strings(&root, "allMathSymbolsByChar"),
        symbols_by_glyph: strings(&root, "allMathSymbolsByGlyph"),
        number_by_glyph: strings(&root, "mathNumberByGlyph"),
        accent_command: strings(&root, "accentToLTXCmd"),
        vowels_with_accents: entries(&root, "vowelsWithAccents")
            .into_iter()
            .map(|(k, v)| {
                (
                    k,
                    Accent {
                        vowel: text(&v, "char"),
                        accent: text(&v, "accent"),
                    },
                )
            })
            .collect(),
        special_font_chars: entries(&root, "specialFontChars")
            .into_iter()
            .map(|(k, v)| {
                (
                    k,
                    SpecialFont {
                        letter: text(&v, "letter"),
                        command: text(&v, "fontCmd"),
                    },
                )
            })
            .collect(),
    }
});
