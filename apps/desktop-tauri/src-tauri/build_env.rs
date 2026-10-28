//! The compiled-in runtime configuration, shared by `build.rs` and its test.
//!
//! Values come from the process environment, then from `apps/desktop-tauri/.env.<MEMRY_ENV>`,
//! and reach the app as `MEMRY_BUILD_<NAME>` (read with `option_env!`). A release build of the
//! production environment refuses to compile without the three values the app cannot work
//! without, and any production build refuses a rehearsal update feed; the error names the
//! variable, never a value.

use std::collections::BTreeMap;

/// Variables compiled in, in the order of `memry_desktop::config::Compiled`.
pub const NAMES: [&str; 5] = [
    "SYNC_SERVER_URL",
    "GOOGLE_CALENDAR_CLIENT_ID",
    "GOOGLE_CALENDAR_CLIENT_SECRET",
    "ONENOTE_CLIENT_ID",
    "UNSPLASH_ACCESS_KEY",
];

/// Missing any of these fails a production release build.
pub const REQUIRED_IN_PRODUCTION: [&str; 3] = [
    "SYNC_SERVER_URL",
    "GOOGLE_CALENDAR_CLIENT_ID",
    "GOOGLE_CALENDAR_CLIENT_SECRET",
];

/// Rehearsal builds set their update feed here; the app reads it as `MEMRY_BUILD_UPDATE_FEED_URL`
/// (`updater/velopack_backend.rs`).
pub const UPDATE_FEED: &str = "MEMRY_UPDATE_FEED_URL";

/// The update feed this build was given, trimmed; blank is none.
pub fn update_feed(inputs: &Inputs) -> Option<String> {
    (inputs.process_env)(UPDATE_FEED)
        .map(|feed| feed.trim().to_owned())
        .filter(|feed| !feed.is_empty())
}

/// `KEY=VALUE` lines: `#` comments, an optional `export `, and one pair of matching quotes.
pub fn parse_env_file(text: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        let value = ['"', '\'']
            .iter()
            .find_map(|q| value.strip_prefix(*q)?.strip_suffix(*q))
            .unwrap_or(value);
        map.insert(key.trim().to_owned(), value.to_owned());
    }
    map
}

pub struct Inputs<'a> {
    /// `release` or `debug`.
    pub profile: &'a str,
    /// The `e2e` cargo feature: a test build, never released.
    pub e2e: bool,
    pub process_env: &'a dyn Fn(&str) -> Option<String>,
    /// The text of `.env.<env>`, when the file exists.
    pub env_file: &'a dyn Fn(&str) -> Option<String>,
}

/// The environment the build is for: `MEMRY_ENV`, else production for a release build and
/// development for everything else (an e2e build is always a development one).
pub fn environment(inputs: &Inputs) -> String {
    match (inputs.process_env)("MEMRY_ENV").map(|v| v.trim().to_owned()) {
        Some(env) if matches!(env.as_str(), "development" | "staging" | "production") => env,
        _ if inputs.profile == "release" && !inputs.e2e => "production".to_owned(),
        _ => "development".to_owned(),
    }
}

/// `(MEMRY_BUILD_<NAME>, value)` pairs, including `MEMRY_BUILD_ENV`, or the error that fails the build.
pub fn resolve(inputs: &Inputs) -> Result<Vec<(String, String)>, String> {
    let env = environment(inputs);
    let feed = update_feed(inputs);
    if env == "production" && feed.is_some() {
        return Err(format!(
            "a MEMRY_ENV=production build must not set {UPDATE_FEED}: it would point every install at another update feed"
        ));
    }
    let file = (inputs.env_file)(&env)
        .map(|text| parse_env_file(&text))
        .unwrap_or_default();
    let mut out = vec![("MEMRY_BUILD_ENV".to_owned(), env.clone())];
    if let Some(feed) = feed {
        out.push((format!("MEMRY_BUILD_{UPDATE_FEED}"), feed));
    }
    for name in NAMES {
        let value = (inputs.process_env)(name)
            .filter(|v| !v.trim().is_empty())
            .or_else(|| file.get(name).cloned().filter(|v| !v.trim().is_empty()));
        match value {
            Some(value) => out.push((format!("MEMRY_BUILD_{name}"), value)),
            None if env == "production"
                && inputs.profile == "release"
                && REQUIRED_IN_PRODUCTION.contains(&name) =>
            {
                return Err(format!(
                    "a release build for MEMRY_ENV=production needs {name}: set it in the environment or in apps/desktop-tauri/.env.production"
                ));
            }
            None => {}
        }
    }
    Ok(out)
}
