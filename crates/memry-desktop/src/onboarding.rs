//! First-run detection for the wizard (`apps/desktop/src/main/onboarding/detect.ts`): the note
//! apps installed on this computer, Obsidian's known vaults, and whether a local model server
//! answers. It runs before any vault is open, and it reads no vault content: only Obsidian's
//! registry file, the existence of the paths it names, and app bundle names.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::local_provider::AgentLocalProviderPreset;
use crate::vault::layout::MEMRY_DIR;

/// `obsidian.json` holds a few hundred bytes. A larger file is refused before it is parsed.
pub const OBSIDIAN_REGISTRY_CAP: u64 = 1024 * 1024;

/// `LOCAL_SERVER_TIMEOUT_MS` (`detect.ts:20`).
pub const LOCAL_SERVER_TIMEOUT: Duration = Duration::from_millis(1500);

/// `MAC_APPS` (`detect.ts:81-89`): the app bundle names of each importer, in Electron's order.
const MAC_APPS: &[(&str, &[&str])] = &[
    ("notion", &["Notion.app"]),
    ("evernote", &["Evernote.app"]),
    ("bear", &["Bear.app"]),
    ("onenote", &["Microsoft OneNote.app"]),
    ("noteplan", &["NotePlan 3.app", "NotePlan.app"]),
    ("todoist", &["Todoist.app"]),
    ("ticktick", &["TickTick.app"]),
];

/// `OnboardingObsidianVault` (`packages/contracts/src/onboarding-api.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingObsidianVault {
    pub name: String,
    pub path: String,
}

/// `OnboardingSources`: Obsidian's vaults and the importer ids whose app is installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingSources {
    pub obsidian_vaults: Vec<OnboardingObsidianVault>,
    pub installed_apps: Vec<String>,
}

/// The folders `installedMacApps` looks in (`detect.ts:91`).
pub fn mac_app_roots(home: &Path) -> Vec<PathBuf> {
    vec![PathBuf::from("/Applications"), home.join("Applications")]
}

/// `detectSources` (`detect.ts:99`). `app_data` is Electron's `app.getPath('appData')`, the OS
/// config folder Obsidian writes its registry under. Installed apps are looked up in
/// `app_roots` ([`mac_app_roots`] outside tests), on macOS only.
pub fn detect_sources(app_data: &Path, app_roots: &[PathBuf]) -> OnboardingSources {
    let installed_apps = if cfg!(target_os = "macos") {
        installed_mac_apps(app_roots)
    } else {
        Vec::new()
    };
    OnboardingSources {
        obsidian_vaults: read_obsidian_vaults(&app_data.join("obsidian").join("obsidian.json")),
        installed_apps,
    }
}

/// `readObsidianVaults` (`detect.ts:59`): every `vaults.*.path` that exists, named by its last
/// component. A missing or unreadable file is no vaults; a malformed one is logged as well.
pub fn read_obsidian_vaults(registry: &Path) -> Vec<OnboardingObsidianVault> {
    let Some(raw) = read_registry(registry) else {
        return Vec::new();
    };
    match vault_paths(&raw) {
        Ok(paths) => paths
            .into_iter()
            .filter(|path| Path::new(path).exists())
            .map(|path| OnboardingObsidianVault {
                name: Path::new(&path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path,
            })
            .collect(),
        Err(reason) => {
            tracing::warn!(
                scope = "onboarding",
                "unreadable Obsidian vault registry: {reason}"
            );
            Vec::new()
        }
    }
}

/// The file as Node's `readFile(path, 'utf8')` reads it (invalid UTF-8 becomes U+FFFD), or
/// `None` when it cannot be read or is over [`OBSIDIAN_REGISTRY_CAP`].
fn read_registry(registry: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    File::open(registry)
        .and_then(|file| file.take(OBSIDIAN_REGISTRY_CAP + 1).read_to_end(&mut bytes))
        .ok()?;
    if bytes.len() as u64 > OBSIDIAN_REGISTRY_CAP {
        tracing::warn!(
            scope = "onboarding",
            "Obsidian vault registry is over {OBSIDIAN_REGISTRY_CAP} bytes; not read"
        );
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The string `path` of each entry of `vaults`, as `Object.values(parsed.vaults ?? {})` walks
/// it. Electron's whole read fails (and logs) where its JavaScript throws: a `null` document or
/// a `null` entry.
fn vault_paths(raw: &str) -> Result<Vec<String>, String> {
    let parsed: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    let vaults = match &parsed {
        Value::Null => return Err("the document is null".to_owned()),
        Value::Object(fields) => fields.get("vaults"),
        _ => None,
    };
    let entries: Vec<&Value> = match vaults {
        Some(Value::Object(by_id)) => by_id.values().collect(),
        Some(Value::Array(list)) => list.iter().collect(),
        _ => Vec::new(),
    };
    let mut paths = Vec::new();
    for entry in entries {
        match entry {
            Value::Null => return Err("a vault entry is null".to_owned()),
            Value::Object(fields) => {
                if let Some(Value::String(path)) = fields.get("path") {
                    paths.push(path.clone());
                }
            }
            _ => {}
        }
    }
    Ok(paths)
}

/// `installedMacApps` (`detect.ts:91`): importer ids with a bundle in any of `roots`.
pub fn installed_mac_apps(roots: &[PathBuf]) -> Vec<String> {
    MAC_APPS
        .iter()
        .filter(|(_, bundles)| {
            bundles
                .iter()
                .any(|bundle| roots.iter().any(|root| root.join(bundle).exists()))
        })
        .map(|(importer, _)| (*importer).to_owned())
        .collect()
}

/// `isVaultInitialized` as the wizard calls it (`vault/init.ts:63`): `.memry` exists. A folder
/// that cannot be looked at is not a vault, as for Node's `existsSync`.
pub fn is_memry_vault(folder: &Path) -> bool {
    folder.join(MEMRY_DIR).try_exists().unwrap_or(false)
}

/// `localServerAnswers` (`detect.ts:27`): `GET <base>/models` answers 2xx within
/// [`LOCAL_SERVER_TIMEOUT`]. The servers run on this computer, so no proxy is asked.
pub async fn local_server_answers(base_url: &str) -> bool {
    let client = match crate::http::builder().no_proxy().build() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(
                scope = "onboarding",
                "no client for the model server probe: {error}"
            );
            return false;
        }
    };
    client
        .get(format!("{base_url}/models"))
        .timeout(LOCAL_SERVER_TIMEOUT)
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

/// The `local_openai_compatible` row of `detectAgents` (`detect.ts:38`): Ollama or LM Studio
/// answers at its preset URL. Both are asked at once.
pub async fn local_model_server_running() -> bool {
    let (ollama, lm_studio) = futures_util::future::join(
        local_server_answers(AgentLocalProviderPreset::Ollama.default_base_url()),
        local_server_answers(AgentLocalProviderPreset::LmStudio.default_base_url()),
    )
    .await;
    ollama || lm_studio
}

#[cfg(test)]
#[path = "onboarding_tests.rs"]
mod tests;
