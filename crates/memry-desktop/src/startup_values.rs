//! The values the renderer needs before first paint: color mode, color theme and zoom.
//!
//! With a vault open they come from its `general` settings group. With none open (the picker,
//! a first launch) they come from the last values `memry-config.json` cached: `startupTheme`,
//! `startupColorTheme` and `zoomFactor`, three additive keys written whenever the general group
//! changes. Once a vault is open the group is the source and the cache is never read.

use serde_json::{Map, Value, json};

use crate::registry::{AppConfig, ConfigError};

const THEME_KEY: &str = "startupTheme";
const COLOR_THEME_KEY: &str = "startupColorTheme";
const ZOOM_KEY: &str = "zoomFactor";
const ZOOM_DEFAULT: f64 = 1.0;

/// The `general` fields the color theme is built from (`parseThemeCustomization`).
const COLOR_FIELDS: [&str; 7] = [
    "colorTheme",
    "accentColor",
    "useThemeAccent",
    "backgroundLight",
    "foregroundLight",
    "backgroundDark",
    "foregroundDark",
];

#[derive(Debug, Clone, PartialEq)]
pub struct StartupValues {
    pub theme: String,
    pub color_theme: Option<Value>,
    pub zoom: f64,
}

/// `clampZoomFactor`: snapped to the 10% grid, then clamped to 0.5 to 2; anything else is 1.
pub fn clamp_zoom(value: &Value) -> f64 {
    match value.as_f64().filter(|n| n.is_finite()) {
        Some(n) => ((n * 10.0).round() / 10.0).clamp(0.5, 2.0),
        None => ZOOM_DEFAULT,
    }
}

fn valid_theme(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|t| matches!(*t, "light" | "dark" | "white" | "system"))
        .map(str::to_owned)
}

fn color_theme_of(general: &Map<String, Value>) -> Option<Value> {
    let picked: Map<String, Value> = COLOR_FIELDS
        .iter()
        .filter_map(|field| {
            general
                .get(*field)
                .map(|v| ((*field).to_owned(), v.clone()))
        })
        .collect();
    (!picked.is_empty()).then_some(Value::Object(picked))
}

/// The startup values: the open vault's `general` group, else the config cache, else defaults.
pub fn read(config: &AppConfig, general: Option<&Map<String, Value>>) -> StartupValues {
    if let Some(general) = general {
        return StartupValues {
            theme: valid_theme(general.get("theme")).unwrap_or_else(|| "system".to_owned()),
            color_theme: color_theme_of(general),
            zoom: general.get("zoomFactor").map_or(ZOOM_DEFAULT, clamp_zoom),
        };
    }
    config.read(|map| StartupValues {
        theme: valid_theme(map.get(THEME_KEY)).unwrap_or_else(|| "system".to_owned()),
        color_theme: map.get(COLOR_THEME_KEY).filter(|v| v.is_object()).cloned(),
        zoom: map.get(ZOOM_KEY).map_or(ZOOM_DEFAULT, clamp_zoom),
    })
}

/// Refreshes the cache from a `general` group. Only the keys that differ are written.
pub fn cache(config: &AppConfig, general: &Map<String, Value>) {
    let values = read(config, Some(general));
    let result = config.update(|map| {
        map.insert(THEME_KEY.to_owned(), json!(values.theme));
        match values.color_theme {
            Some(color) => map.insert(COLOR_THEME_KEY.to_owned(), color),
            None => map.remove(COLOR_THEME_KEY),
        };
        map.insert(ZOOM_KEY.to_owned(), json!(values.zoom));
        Ok::<_, ConfigError>(())
    });
    if let Err(error) = result {
        tracing::warn!(
            scope = "StartupValues",
            "could not cache the startup values: {error}"
        );
    }
}

/// Stores the zoom factor alone (`app_set_zoom_factor`).
pub fn set_zoom(config: &AppConfig, zoom: &Value) -> Result<f64, ConfigError> {
    let clamped = clamp_zoom(zoom);
    config.update(|map| {
        map.insert(ZOOM_KEY.to_owned(), json!(clamped));
        Ok::<_, ConfigError>(())
    })?;
    Ok(clamped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> (AppConfig, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tmp");
        (AppConfig::load(dir.path().join("memry-config.json")), dir)
    }

    fn general() -> Map<String, Value> {
        json!({"theme": "dark", "colorTheme": "warm", "accentColor": "#112233", "zoomFactor": 1.26, "language": "de"})
            .as_object()
            .cloned()
            .expect("object")
    }

    #[test]
    fn zoom_snaps_to_the_grid_and_clamps() {
        for (input, want) in [
            (json!(1.26), 1.3),
            (json!(0.1), 0.5),
            (json!(9), 2.0),
            (json!("x"), 1.0),
            (json!(null), 1.0),
        ] {
            assert_eq!(clamp_zoom(&input), want, "{input}");
        }
    }

    #[test]
    fn an_open_vault_wins_and_the_cache_serves_the_picker() {
        let (config, _dir) = config();
        assert_eq!(
            read(&config, None),
            StartupValues {
                theme: "system".into(),
                color_theme: None,
                zoom: 1.0
            }
        );
        let general = general();
        let live = read(&config, Some(&general));
        assert_eq!((live.theme.as_str(), live.zoom), ("dark", 1.3));
        assert_eq!(
            live.color_theme.as_ref().expect("color")["colorTheme"],
            "warm"
        );
        assert!(
            live.color_theme
                .as_ref()
                .expect("color")
                .get("language")
                .is_none()
        );

        cache(&config, &general);
        assert_eq!(read(&config, None), live);
        // A different open vault does not read the cache.
        let other = json!({"theme": "light"}).as_object().cloned().expect("o");
        assert_eq!(read(&config, Some(&other)).theme, "light");
    }

    #[test]
    fn set_zoom_clamps_and_persists() {
        let (config, _dir) = config();
        assert_eq!(set_zoom(&config, &json!(3)).expect("set"), 2.0);
        assert_eq!(read(&config, None).zoom, 2.0);
    }
}
