//! The UI language: the supported list, OS detection and the startup choice
//! (`apps/desktop/src/main/startup-locale.ts`, `bootI18n` of `main/index.ts`).

use std::sync::{PoisonError, RwLock};

use crate::registry::AppConfig;

/// `SUPPORTED_LOCALES` of `@memry/contracts/locale-api`, in its order. The renderer lists them
/// in this order, and a test pins it to the embedded catalog.
pub const SUPPORTED: [&str; 32] = [
    "ar", "cs", "da", "en", "de", "el", "es", "fi", "fil", "fr", "he", "hr", "hu", "id", "it",
    "ja", "ko", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "th", "tr", "uk", "vi",
    "zh-CN", "zh-TW",
];

/// The `locale` key of `memry-config.json`.
const CONFIG_KEY: &str = "locale";

/// Languages written right to left.
pub fn is_rtl(locale: &str) -> bool {
    matches!(locale, "ar" | "he")
}

pub fn direction(locale: &str) -> &'static str {
    if is_rtl(locale) { "rtl" } else { "ltr" }
}

/// The supported locale spelled `tag` (case-insensitive), if any.
pub fn supported(tag: &str) -> Option<&'static str> {
    SUPPORTED
        .iter()
        .copied()
        .find(|locale| locale.eq_ignore_ascii_case(tag))
}

fn alias(tag: &str) -> Option<&'static str> {
    Some(match tag {
        "zh" | "zh-hans" | "zh-cn" | "zh-sg" => "zh-CN",
        "zh-hant" | "zh-tw" | "zh-hk" => "zh-TW",
        "nb" | "nn" => "no",
        _ => return None,
    })
}

/// Maps an OS tag onto a supported locale: underscores become hyphens, subtags drop from the
/// most to the least specific, and the first hit wins (`zh-Hant-TW` is `zh-TW`, `de-AT` is
/// `de`). Anything else is English.
pub fn resolve_os_locale(os_locale: Option<&str>) -> &'static str {
    let normalized = os_locale
        .unwrap_or("")
        .trim()
        .replace('_', "-")
        .to_lowercase();
    if normalized.is_empty() {
        return crate::i18n::FALLBACK;
    }
    let subtags: Vec<&str> = normalized.split('-').collect();
    for end in (1..=subtags.len()).rev() {
        let candidate = subtags[..end].join("-");
        if let Some(locale) = alias(&candidate).or_else(|| supported(&candidate)) {
            return locale;
        }
    }
    crate::i18n::FALLBACK
}

/// The stored app-level locale, when it is a supported one.
pub fn stored(config: &AppConfig) -> Option<&'static str> {
    config.read(|map| {
        map.get(CONFIG_KEY)
            .and_then(|v| v.as_str())
            .and_then(supported)
    })
}

/// Persists the app-level locale. A failed write is logged: the choice is not lost for this
/// run, and the next launch falls back to the vault preference or English.
pub fn store(config: &AppConfig, locale: &str) {
    let result = config.update(|map| {
        map.insert(CONFIG_KEY.to_owned(), locale.into());
        Ok::<_, crate::registry::ConfigError>(())
    });
    if let Err(error) = result {
        tracing::warn!(
            scope = "Locale",
            "could not persist locale {locale}: {error}"
        );
    }
}

/// The locale to boot with. A stored one wins; a fresh install (no current vault and no
/// vault ever opened) adopts the OS language once and stores it; a valid vault preference
/// overrides either.
pub fn resolve_startup(
    config: &AppConfig,
    has_vaults: bool,
    has_current_vault: bool,
    vault_preference: Option<&str>,
    os_locale: impl FnOnce() -> Option<String>,
) -> &'static str {
    let mut locale = stored(config);
    if locale.is_none() && !has_current_vault && !has_vaults {
        let detected = resolve_os_locale(os_locale().as_deref());
        tracing::info!(
            scope = "Locale",
            "first run: adopting the OS locale as {detected}"
        );
        store(config, detected);
        locale = Some(detected);
    }
    vault_preference
        .and_then(supported)
        .or(locale)
        .unwrap_or(crate::i18n::FALLBACK)
}

/// The live locale: what native strings use and what `locale_get` answers.
pub struct LocaleService {
    active: RwLock<&'static str>,
}

impl LocaleService {
    pub fn new(initial: &'static str) -> Self {
        Self {
            active: RwLock::new(initial),
        }
    }

    pub fn get(&self) -> &'static str {
        *self.active.read().unwrap_or_else(PoisonError::into_inner)
    }

    /// Switches the live locale and returns whether it changed. The caller persists only after
    /// this succeeds, so a switch that fails leaves the stores agreeing with the runtime.
    pub fn switch(&self, locale: &'static str) -> bool {
        let mut active = self.active.write().unwrap_or_else(PoisonError::into_inner);
        let changed = *active != locale;
        *active = locale;
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded(json: &str) -> (AppConfig, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("memry-config.json");
        std::fs::write(&path, json).expect("seed");
        (AppConfig::load(path), dir)
    }

    #[test]
    fn the_list_is_the_embedded_catalog() {
        let mut have: Vec<_> = crate::i18n::locales().collect();
        have.sort_unstable();
        let mut want = SUPPORTED.to_vec();
        want.sort_unstable();
        assert_eq!(have, want);
    }

    #[test]
    fn os_tags_resolve_like_resolve_os_locale() {
        for (tag, want) in [
            ("de_AT", "de"),
            ("zh-Hant-TW", "zh-TW"),
            ("zh", "zh-CN"),
            ("zh-HK", "zh-TW"),
            ("nb-NO", "no"),
            ("nn", "no"),
            ("pt-BR", "pt"),
            ("en-GB", "en"),
            ("fil-PH", "fil"),
            ("xx", "en"),
            ("", "en"),
        ] {
            assert_eq!(resolve_os_locale(Some(tag)), want, "{tag}");
        }
        assert_eq!(resolve_os_locale(None), "en");
    }

    #[test]
    fn a_fresh_install_adopts_and_stores_the_os_locale_once() {
        let (config, _dir) = seeded("{}");
        assert_eq!(
            resolve_startup(&config, false, false, None, || Some("de_DE".into())),
            "de"
        );
        assert_eq!(stored(&config), Some("de"));
        // The stored value now wins over a different OS locale.
        assert_eq!(
            resolve_startup(&config, false, false, None, || Some("fr".into())),
            "de"
        );
    }

    #[test]
    fn an_existing_install_without_a_locale_stays_english_and_a_vault_preference_overrides() {
        let (config, _dir) = seeded("{}");
        assert_eq!(
            resolve_startup(&config, true, false, None, || Some("de".into())),
            "en"
        );
        assert_eq!(stored(&config), None);
        let (config, _dir) = seeded(r#"{"locale":"de"}"#);
        assert_eq!(
            resolve_startup(&config, true, true, Some("ja"), || None),
            "ja"
        );
        assert_eq!(
            resolve_startup(&config, true, true, Some("xx"), || None),
            "de"
        );
    }

    #[test]
    fn the_service_reports_a_change_once() {
        let service = LocaleService::new("en");
        assert!(service.switch("ar"));
        assert!(!service.switch("ar"));
        assert_eq!(
            (service.get(), direction("ar"), direction("de")),
            ("ar", "rtl", "ltr")
        );
    }
}
