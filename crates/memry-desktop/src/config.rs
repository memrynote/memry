//! Runtime configuration: the environment (`MEMRY_ENV`), the sync server URL and the client ids
//! a build was made with. Values are compiled in by `apps/desktop-tauri/src-tauri/build.rs`
//! (process environment, then `.env.<MEMRY_ENV>`); no env file ships in the bundle.
//!
//! A launch switch (`MEMRY_ENV`, `SYNC_SERVER_URL`, `TELEMETRY_ENDPOINT`) overrides the
//! compiled value only when the build is not production, so a released app cannot be
//! pointed elsewhere by its environment. [`RuntimeConfig::sync_server_url`] is the one place
//! the server URL is read; nothing else reads `SYNC_SERVER_URL`.

use crate::launch_env::LaunchEnv;

pub const PRODUCTION_SYNC_URL: &str = "https://sync.memrynote.com";
const DEVELOPMENT_SYNC_URL: &str = "http://localhost:8787";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemryEnv {
    Development,
    Staging,
    Production,
}

impl MemryEnv {
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "development" => Some(Self::Development),
            "staging" => Some(Self::Staging),
            "production" => Some(Self::Production),
            _ => None,
        }
    }

    /// The `buildChannel` of telemetry.
    pub fn build_channel(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Staging => "staging",
            Self::Production => "production",
        }
    }
}

/// What the build script compiled in. Every field is `option_env!` of a `MEMRY_BUILD_*` name.
#[derive(Debug, Clone, Copy, Default)]
pub struct Compiled {
    pub env: Option<&'static str>,
    pub sync_server_url: Option<&'static str>,
    pub google_calendar_client_id: Option<&'static str>,
    pub google_calendar_client_secret: Option<&'static str>,
    pub onenote_client_id: Option<&'static str>,
    pub unsplash_access_key: Option<&'static str>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeConfig {
    pub env: MemryEnv,
    pub sync_server_url: String,
    pub telemetry_endpoint_override: Option<String>,
    pub google_calendar_client_id: Option<String>,
    pub google_calendar_client_secret: Option<String>,
    pub onenote_client_id: Option<String>,
    pub unsplash_access_key: Option<String>,
}

// The secrets stay out of any `{:?}` that reaches a log.
impl std::fmt::Debug for RuntimeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeConfig")
            .field("env", &self.env)
            .field("sync_server_url", &self.sync_server_url)
            .finish_non_exhaustive()
    }
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

impl RuntimeConfig {
    pub fn resolve(compiled: &Compiled, env: &LaunchEnv) -> Self {
        let compiled_env = compiled
            .env
            .and_then(MemryEnv::parse)
            .unwrap_or(MemryEnv::Production);
        let overridable = compiled_env != MemryEnv::Production;
        let launch = |name: &str| {
            if overridable {
                non_empty(env.get(name))
            } else {
                None
            }
        };

        let env_kind = launch("MEMRY_ENV")
            .and_then(|v| MemryEnv::parse(&v))
            .unwrap_or(compiled_env);
        let sync_server_url = launch("SYNC_SERVER_URL")
            .or_else(|| non_empty(compiled.sync_server_url))
            .unwrap_or_else(|| {
                if env_kind == MemryEnv::Development {
                    DEVELOPMENT_SYNC_URL
                } else {
                    PRODUCTION_SYNC_URL
                }
                .to_owned()
            });
        Self {
            env: env_kind,
            sync_server_url: sync_server_url.trim_end_matches('/').to_owned(),
            telemetry_endpoint_override: launch("TELEMETRY_ENDPOINT"),
            google_calendar_client_id: non_empty(compiled.google_calendar_client_id),
            google_calendar_client_secret: non_empty(compiled.google_calendar_client_secret),
            onenote_client_id: non_empty(compiled.onenote_client_id),
            unsplash_access_key: non_empty(compiled.unsplash_access_key),
        }
    }

    pub fn build_channel(&self) -> &'static str {
        self.env.build_channel()
    }

    /// `POST` target of a sync-server path (`/telemetry/batch`, `/feedback`).
    pub fn server_url(&self, path: &str) -> String {
        format!("{}{path}", self.sync_server_url)
    }

    pub fn telemetry_batch_endpoint(&self) -> String {
        self.telemetry_endpoint_override
            .clone()
            .unwrap_or_else(|| self.server_url("/telemetry/batch"))
    }

    /// The loopback hosts the configured server URLs name (a local sync server in development or
    /// an e2e run), which the sync transport serves beside the memry hosts. Nothing else: a
    /// configured host off this machine still has to be a memry host.
    pub fn loopback_hosts(&self) -> Vec<String> {
        let mut hosts: Vec<String> = [
            Some(&self.sync_server_url),
            self.telemetry_endpoint_override.as_ref(),
        ]
        .into_iter()
        .flatten()
        .filter_map(|url| {
            url::Url::parse(url)
                .ok()?
                .host_str()
                .map(str::to_ascii_lowercase)
        })
        .filter(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]"))
        .collect();
        hosts.dedup();
        hosts
    }

    /// Enabled when the stored flag says so; else `MEMRY_TELEMETRY_ENABLED=true`; else on only for
    /// the production channel.
    pub fn telemetry_enabled(&self, stored: Option<bool>, env: &LaunchEnv) -> bool {
        stored.unwrap_or_else(|| {
            env.get("MEMRY_TELEMETRY_ENABLED") == Some("true") || self.env == MemryEnv::Production
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(pairs: &[(&str, &str)]) -> LaunchEnv {
        let mut env = LaunchEnv::from_process();
        for name in [
            "MEMRY_ENV",
            "SYNC_SERVER_URL",
            "TELEMETRY_ENDPOINT",
            "MEMRY_TELEMETRY_ENABLED",
        ] {
            env.set(name, "");
        }
        for (key, value) in pairs {
            env.set(key, value);
        }
        env
    }

    #[test]
    fn a_production_build_ignores_launch_overrides() {
        let compiled = Compiled {
            env: Some("production"),
            sync_server_url: Some("https://sync.example.com/"),
            ..Compiled::default()
        };
        let config = RuntimeConfig::resolve(
            &compiled,
            &launch(&[
                ("MEMRY_ENV", "staging"),
                ("SYNC_SERVER_URL", "http://evil"),
                ("TELEMETRY_ENDPOINT", "http://evil/x"),
            ]),
        );
        assert_eq!(config.env, MemryEnv::Production);
        assert_eq!(config.sync_server_url, "https://sync.example.com");
        assert_eq!(
            config.telemetry_batch_endpoint(),
            "https://sync.example.com/telemetry/batch"
        );
    }

    #[test]
    fn a_development_build_takes_the_launch_switches_and_defaults_to_localhost() {
        let compiled = Compiled {
            env: Some("development"),
            ..Compiled::default()
        };
        let plain = RuntimeConfig::resolve(&compiled, &launch(&[]));
        assert_eq!(
            (plain.env, plain.sync_server_url.as_str()),
            (MemryEnv::Development, "http://localhost:8787")
        );
        let staged = RuntimeConfig::resolve(
            &compiled,
            &launch(&[
                ("MEMRY_ENV", "staging"),
                ("SYNC_SERVER_URL", "http://127.0.0.1:9/"),
                ("TELEMETRY_ENDPOINT", "http://127.0.0.1:9/t"),
            ]),
        );
        assert_eq!(staged.build_channel(), "staging");
        assert_eq!(
            staged.server_url("/feedback"),
            "http://127.0.0.1:9/feedback"
        );
        assert_eq!(staged.telemetry_batch_endpoint(), "http://127.0.0.1:9/t");
        assert_eq!(plain.loopback_hosts(), ["localhost"]);
        assert_eq!(staged.loopback_hosts(), ["127.0.0.1"]);
        let lan = RuntimeConfig::resolve(
            &compiled,
            &launch(&[("SYNC_SERVER_URL", "http://192.168.1.4:8787")]),
        );
        assert!(lan.loopback_hosts().is_empty());
    }

    #[test]
    fn telemetry_defaults_on_only_for_production_and_the_stored_flag_wins() {
        let prod = RuntimeConfig::resolve(&Compiled::default(), &launch(&[]));
        assert!(prod.telemetry_enabled(None, &launch(&[])));
        assert!(!prod.telemetry_enabled(Some(false), &launch(&[])));
        let dev = RuntimeConfig::resolve(
            &Compiled {
                env: Some("development"),
                ..Compiled::default()
            },
            &launch(&[]),
        );
        assert!(!dev.telemetry_enabled(None, &launch(&[])));
        assert!(dev.telemetry_enabled(None, &launch(&[("MEMRY_TELEMETRY_ENABLED", "true")])));
        assert!(!format!("{prod:?}").contains("client_secret"));
    }
}
