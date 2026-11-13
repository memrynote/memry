//! The probe caches of the engine (`resolveProbe`, `runProbe`, `turnTools` and `acceptsImages` of
//! `local-openai-compatible-backend.ts`). The probes themselves are `local_provider::probe`.
//!
//! Each cache is a single slot: only one provider configuration is live at a time, so an entry
//! for an older one is worthless and none can grow. The key is compared by value and never
//! hashed or derived: the caches only need to know whether it changed.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures_util::FutureExt as _;
use futures_util::future::{BoxFuture, Shared};
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::ai::catalog::ProbeClient;
use crate::ai::local_provider::probe::{
    self, AgentLocalProviderProbeResult, ToolChoice, ToolVerdict,
};
use crate::ai::local_provider::{AgentLocalProviderPreset, LocalProvider};

/// How long a yes of the image-input probe holds; the provider can swap the model behind a name.
pub const IMAGE_PROBE_TTL: Duration = Duration::from_secs(10 * 60);
/// A no expires faster, because a provider error looks the same.
pub const IMAGE_PROBE_DEGRADED_TTL: Duration = Duration::from_secs(60);

/// What a turn's tools follow: the probe result and its verdict. A transient verdict never
/// leaves [`Probes::resolve`]: it turns into `On` with the last known profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalProbe {
    pub result: AgentLocalProviderProbeResult,
    pub tools: ToolVerdict,
}

/// `probeSettingsKey` (preset, base URL and model) plus the key.
#[derive(Clone, PartialEq, Eq)]
struct Fingerprint {
    preset: AgentLocalProviderPreset,
    base_url: String,
    model: String,
    key: Option<Zeroizing<String>>,
}

impl Fingerprint {
    fn of(provider: &LocalProvider) -> Self {
        Self {
            preset: provider.preset,
            base_url: provider.base_url.clone(),
            model: provider.model.clone(),
            key: provider.api_key.clone(),
        }
    }
}

type Flight = Shared<BoxFuture<'static, probe::ProbeRun>>;

struct ImageEntry {
    fingerprint: Fingerprint,
    chat_model: String,
    accepts: bool,
    expires_at: Instant,
}

#[derive(Default)]
pub(super) struct Probes {
    cache: Mutex<Option<(Fingerprint, LocalProbe)>>,
    /// Two turns starting at once share one probe instead of racing.
    in_flight: Mutex<Option<(Fingerprint, Flight)>>,
    /// The probe `turn_has_tools` answered from, for the run that follows. Taken once.
    reserved: Mutex<Option<(Fingerprint, LocalProbe)>>,
    images: Mutex<Option<ImageEntry>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Probes {
    /// `resolveProbe`. `force` (the settings screen) skips the cache and the shared flight.
    pub async fn resolve(
        &self,
        client: &Arc<ProbeClient>,
        provider: &LocalProvider,
        force: bool,
    ) -> LocalProbe {
        let fingerprint = Fingerprint::of(provider);
        let flight = {
            if !force
                && let Some((cached, probe)) = &*lock(&self.cache)
                && *cached == fingerprint
            {
                return probe.clone();
            }
            let mut in_flight = lock(&self.in_flight);
            match &*in_flight {
                Some((running, flight)) if !force && *running == fingerprint => flight.clone(),
                _ => {
                    let client = client.clone();
                    let provider = provider.clone();
                    let flight = async move { probe::probe(&client, &provider).await }
                        .boxed()
                        .shared();
                    if !force {
                        *in_flight = Some((fingerprint.clone(), flight.clone()));
                    }
                    flight
                }
            }
        };
        let run = flight.clone().await;
        {
            let mut in_flight = lock(&self.in_flight);
            if in_flight
                .as_ref()
                .is_some_and(|(_, running)| running.ptr_eq(&flight))
            {
                *in_flight = None;
            }
        }
        self.settle(fingerprint, run)
    }

    /// `runProbe`: a transient verdict is not cached and keeps tools on with the profile of the
    /// last pass for this configuration; if the provider still fails, the turn shows that error
    /// instead of quietly losing tools. A pass or a model verdict holds until the configuration
    /// or the key changes. An unreachable provider, a missing model and no streaming are fixed
    /// outside the app and never cached, so starting the server takes effect next turn.
    fn settle(&self, fingerprint: Fingerprint, run: probe::ProbeRun) -> LocalProbe {
        let mut cache = lock(&self.cache);
        if run.tools == ToolVerdict::Transient {
            let known = match &*cache {
                Some((
                    cached,
                    LocalProbe {
                        tools: ToolVerdict::On(choice),
                        ..
                    },
                )) if *cached == fingerprint => *choice,
                _ => ToolChoice::Auto,
            };
            return LocalProbe {
                result: run.result,
                tools: ToolVerdict::On(known),
            };
        }
        let probe = LocalProbe {
            result: run.result,
            tools: run.tools,
        };
        let cacheable = probe.result.connected
            && probe.result.model_available
            && probe.result.streaming_supported;
        *cache = cacheable.then(|| (fingerprint, probe.clone()));
        probe
    }

    /// `turnHasTools`: probes (or reads the cache) and keeps the answer for the next run.
    pub async fn reserve_for_turn(
        &self,
        client: &Arc<ProbeClient>,
        provider: &LocalProvider,
    ) -> bool {
        let probe = self.resolve(client, provider, false).await;
        let on = matches!(probe.tools, ToolVerdict::On(_));
        *lock(&self.reserved) = Some((Fingerprint::of(provider), probe));
        on
    }

    /// `turnTools`: the reserved answer when it is for this configuration and key, else a probe.
    pub async fn for_run(
        &self,
        client: &Arc<ProbeClient>,
        provider: &LocalProvider,
    ) -> ToolVerdict {
        let reserved = lock(&self.reserved).take();
        if let Some((fingerprint, probe)) = reserved
            && fingerprint == Fingerprint::of(provider)
        {
            return probe.tools;
        }
        self.resolve(client, provider, false).await.tools
    }

    /// `acceptsImages`: learned the first time a tool returns an image (FB-002). The chat's model
    /// is part of the key, because a chat can pick a model other than the configured one.
    pub async fn accepts_images(
        &self,
        client: &ProbeClient,
        provider: &LocalProvider,
        chat_model: &str,
    ) -> bool {
        let fingerprint = Fingerprint::of(provider);
        if let Some(entry) = &*lock(&self.images)
            && entry.fingerprint == fingerprint
            && entry.chat_model == chat_model
            && entry.expires_at > Instant::now()
        {
            return entry.accepts;
        }
        let accepts = probe::image_input(client, provider, chat_model).await;
        let ttl = if accepts {
            IMAGE_PROBE_TTL
        } else {
            IMAGE_PROBE_DEGRADED_TTL
        };
        *lock(&self.images) = Some(ImageEntry {
            fingerprint,
            chat_model: chat_model.to_owned(),
            accepts,
            expires_at: Instant::now() + ttl,
        });
        accepts
    }
}
