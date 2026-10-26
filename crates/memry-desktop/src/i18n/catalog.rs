//! The embedded messages: one lazily indexed table per locale.

use std::collections::HashMap;
use std::sync::{LazyLock, OnceLock};

include!(concat!(env!("OUT_DIR"), "/catalog_data.rs"));

const UNIT: char = '\u{1f}';
const RECORD: char = '\u{1e}';

type Table = HashMap<&'static str, &'static str>;

static TABLES: LazyLock<Vec<(&'static str, OnceLock<Table>)>> = LazyLock::new(|| {
    LOCALES
        .iter()
        .map(|(locale, _)| (*locale, OnceLock::new()))
        .collect()
});

fn table(locale: &str) -> Option<&'static Table> {
    let (index, _) = LOCALES
        .iter()
        .enumerate()
        .find(|(_, (tag, _))| *tag == locale)?;
    let (_, cell) = &TABLES[index];
    Some(cell.get_or_init(|| {
        LOCALES[index]
            .1
            .split(RECORD)
            .filter_map(|record| record.split_once(UNIT))
            .collect()
    }))
}

/// The raw template of `ns:dotted.key` in `locale`, `None` when that locale has no such key.
pub fn lookup(locale: &str, key: &str) -> Option<&'static str> {
    table(locale)?.get(key).copied()
}

pub fn has_locale(locale: &str) -> bool {
    LOCALES.iter().any(|(tag, _)| *tag == locale)
}

pub fn locales() -> impl Iterator<Item = &'static str> {
    LOCALES.iter().map(|(tag, _)| *tag)
}

/// Every `ns:key` of `locale`, for the parity test.
pub fn keys(locale: &str) -> Vec<&'static str> {
    table(locale)
        .map(|t| t.keys().copied().collect())
        .unwrap_or_default()
}
