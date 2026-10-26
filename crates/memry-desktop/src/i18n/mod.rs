//! Native strings: the same locale files as the renderer, formatted with the MessageFormat
//! subset `intl-messageformat` gives the Electron main process (`packages/i18n`).

mod catalog;
mod format;

pub use catalog::{has_locale, keys, locales};
pub use format::{Arg, Args, format_message};

/// The locale every other falls back to, `FALLBACK_LOCALE` of `@memry/contracts`.
pub const FALLBACK: &str = "en";
/// The namespace a key without `ns:` belongs to (`DEFAULT_NAMESPACE` of `@memry/i18n`).
const DEFAULT_NAMESPACE: &str = "common";

/// Translates `ns:dotted.key` the way `createMainI18n().t(key, args)` does: the requested
/// locale, then English; a key neither has comes back as `ns:key`.
pub fn t(locale: &str, key: &str, args: &Args) -> String {
    let full = if key.contains(':') {
        key.to_owned()
    } else {
        format!("{DEFAULT_NAMESPACE}:{key}")
    };
    match catalog::lookup(locale, &full).or_else(|| catalog::lookup(FALLBACK, &full)) {
        Some(template) => format_message(template, locale, args),
        None => full,
    }
}

/// The raw template `t` would format: the locale's own, else English.
pub fn raw(locale: &str, key: &str) -> Option<&'static str> {
    catalog::lookup(locale, key).or_else(|| catalog::lookup(FALLBACK, key))
}
