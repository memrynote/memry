//! The OCR languages of this machine: which ones the user chose, and their data. Port of
//! `apps/desktop/src/main/file-text/ocr-languages.ts`.
//!
//! English ships with the app. Every other language is downloaded from the sync server on demand
//! into `<app data>/ocr-languages`, never synced. OCR reads a downloaded file only once its sha256
//! matched the one this build pins (`data.generated.rs`) in this run: right after the download, or
//! when the first pass of a run checks the file an earlier run left. The files stay gzip bytes, as
//! Electron stored them, so a pack Electron downloaded passes the same pin. Tesseract reads plain
//! `.traineddata`, which [`OcrLanguages::datapath`] unpacks into `<app data>/ocr-cache`.
//!
//! [`OcrLanguages::sync`] converges the folder on the choice: it deletes data of languages no
//! longer chosen and downloads the chosen ones it lacks, one at a time. A failed download stays
//! failed until the next app start or a retry.

mod cache;
#[path = "data.generated.rs"]
mod data;
mod download;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::locale::LocaleService;
use crate::registry::{AppConfig, ConfigError};
use crate::seams::transport::SyncTransport;

pub use cache::{CACHE_DIR, unpack};
pub use data::{OcrLanguage, PINS};

/// The folder of the downloaded packs under the app data dir (`ocr-languages.ts:63`).
pub const DATA_DIR: &str = "ocr-languages";
/// `DOWNLOAD_TIMEOUT_MS` (`ocr-languages.ts:40`): the whole request, body included.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// The exact bytes the server serves for one language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pin {
    pub bytes: u64,
    pub sha256: &'static str,
}

/// Where one chosen language stands (`OcrLanguageStatus` of `ocr-languages-api.ts`). `error` is an
/// `errors:` i18n key the settings row shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum OcrLanguageStatus {
    Ready,
    #[serde(rename_all = "camelCase")]
    Downloading {
        received_bytes: u64,
        total_bytes: u64,
    },
    Failed {
        error: String,
    },
}

/// `OcrLanguagesState` of `ocr-languages-api.ts`: the chosen languages, English first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OcrLanguagesState {
    pub selected: Vec<OcrLanguage>,
    pub statuses: BTreeMap<OcrLanguage, OcrLanguageStatus>,
}

impl OcrLanguage {
    pub fn from_code(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|lang| lang.code() == code)
    }

    /// The name of its pack in [`DATA_DIR`], and of its unpacked data in [`CACHE_DIR`].
    pub fn file_name(self) -> String {
        format!("{}.traineddata", self.code())
    }
}

pub struct OcrLanguagesDeps {
    pub config: Arc<AppConfig>,
    pub locale: Arc<LocaleService>,
    pub app_data_dir: PathBuf,
    /// The sync server base URL; packs come from `<url>/ocr/v1/<lang>.traineddata.gz`.
    pub server_url: String,
    /// The app's pinned transport to the sync server.
    pub transport: SyncTransport,
    /// [`PINS`] in a build.
    pub pins: &'static [(OcrLanguage, Pin)],
    pub download_timeout: Duration,
    /// Called with the new state after every change, under the service's lock: it must not call
    /// back into the service.
    pub on_change: Box<dyn Fn(OcrLanguagesState) + Send + Sync>,
    pub runtime: tokio::runtime::Handle,
}

/// What this run knows beyond the config: which packs checked out, and the downloads that ran
/// and are not ready (downloading or failed).
#[derive(Default)]
struct Live {
    verified: HashSet<OcrLanguage>,
    statuses: HashMap<OcrLanguage, OcrLanguageStatus>,
}

pub struct OcrLanguages {
    config: Arc<AppConfig>,
    locale: Arc<LocaleService>,
    dir: PathBuf,
    cache_dir: PathBuf,
    server_url: String,
    transport: SyncTransport,
    pins: &'static [(OcrLanguage, Pin)],
    download_timeout: Duration,
    on_change: Box<dyn Fn(OcrLanguagesState) + Send + Sync>,
    runtime: tokio::runtime::Handle,
    live: Mutex<Live>,
    download: Mutex<Option<(OcrLanguage, CancellationToken)>>,
    /// One pass at a time; a request that arrives during a pass gets one more pass after it.
    pass: tokio::sync::Mutex<()>,
    requested: AtomicU64,
    done: AtomicU64,
}

impl OcrLanguages {
    pub fn new(deps: OcrLanguagesDeps) -> Arc<Self> {
        Arc::new(Self {
            transport: deps.transport,
            dir: deps.app_data_dir.join(DATA_DIR),
            cache_dir: deps.app_data_dir.join(CACHE_DIR),
            server_url: deps.server_url.trim_end_matches('/').to_owned(),
            config: deps.config,
            locale: deps.locale,
            pins: deps.pins,
            download_timeout: deps.download_timeout,
            on_change: deps.on_change,
            runtime: deps.runtime,
            live: Mutex::default(),
            download: Mutex::default(),
            pass: tokio::sync::Mutex::default(),
            requested: AtomicU64::new(0),
            done: AtomicU64::new(0),
        })
    }

    pub fn state(&self) -> OcrLanguagesState {
        self.state_of(&self.lock())
    }

    /// What OCR reads with now: English and every chosen language whose data checked out
    /// (`ocrLanguageSet().codes`).
    pub fn ready(&self) -> Vec<OcrLanguage> {
        let live = self.lock();
        self.selected()
            .into_iter()
            .filter(|lang| self.status_of(&live, *lang) == OcrLanguageStatus::Ready)
            .collect()
    }

    /// A Tesseract data dir holding the plain `.traineddata` of every downloaded language in
    /// `langs`, unpacked from packs that matched their pin in this run. English is not in it: it
    /// ships with the app, and the OCR engine unpacks the bundled pack with [`unpack`] into the
    /// same dir. Blocking file work.
    pub fn datapath(&self, langs: &[OcrLanguage]) -> std::io::Result<PathBuf> {
        for &lang in langs {
            if lang == OcrLanguage::BUNDLED {
                continue;
            }
            let pin = self
                .pin(lang)
                .filter(|_| self.lock().verified.contains(&lang));
            let Some(pin) = pin else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("the {} data is not ready", lang.code()),
                ));
            };
            unpack(
                &self.cache_dir,
                lang,
                &self.dir.join(lang.file_name()),
                pin.sha256,
            )?;
        }
        Ok(self.cache_dir.clone())
    }

    /// Stores the choice (English always in it), stops the download of a language no longer
    /// chosen and starts converging.
    pub fn set(
        self: &Arc<Self>,
        languages: &[OcrLanguage],
    ) -> Result<OcrLanguagesState, ConfigError> {
        let mut chosen = vec![OcrLanguage::BUNDLED];
        for &lang in languages {
            if !chosen.contains(&lang) {
                chosen.push(lang);
            }
        }
        let codes: Vec<String> = chosen.iter().map(|lang| lang.code().to_owned()).collect();
        {
            let live = self.lock();
            self.config.set_ocr_languages(&codes)?;
            (self.on_change)(self.state_of(&live));
        }
        if let Some((lang, token)) = &*self.download.lock().unwrap_or_else(PoisonError::into_inner)
            && !chosen.contains(lang)
        {
            token.cancel();
        }
        self.spawn_sync();
        Ok(self.state())
    }

    /// Clears the failed downloads and converges again.
    pub fn retry(self: &Arc<Self>) -> OcrLanguagesState {
        self.lock()
            .statuses
            .retain(|_, status| !matches!(status, OcrLanguageStatus::Failed { .. }));
        self.spawn_sync();
        self.state()
    }

    /// Downloads what the app language needs (`startOcrLanguages`, once the window shows).
    pub fn start(self: &Arc<Self>) {
        self.spawn_sync();
    }

    /// The app language changed: until the user chooses, the choice follows it.
    pub fn locale_changed(self: &Arc<Self>) {
        self.publish(|_| {});
        self.spawn_sync();
    }

    fn spawn_sync(self: &Arc<Self>) {
        let this = self.clone();
        self.runtime.spawn(async move { this.sync().await });
    }

    /// Converges, or waits for the pass in progress and converges once more after it when that
    /// pass started before this call. Never fails: a failed step is logged or shown as a status.
    pub async fn sync(&self) {
        let ticket = self.requested.fetch_add(1, Ordering::SeqCst) + 1;
        let _pass = self.pass.lock().await;
        if self.done.load(Ordering::SeqCst) >= ticket {
            return;
        }
        let upto = self.requested.load(Ordering::SeqCst);
        self.reconcile().await;
        self.done.store(upto, Ordering::SeqCst);
    }

    async fn reconcile(&self) {
        let selected = self.selected();
        let keep: HashSet<String> = selected
            .iter()
            .filter(|lang| **lang != OcrLanguage::BUNDLED)
            .map(|lang| lang.file_name())
            .collect();
        let names = file_names(&self.dir).await;
        for name in names.iter().filter(|name| !keep.contains(*name)) {
            remove(&self.dir.join(name)).await;
        }
        for name in file_names(&self.cache_dir).await {
            let code = name.split('.').next().unwrap_or_default();
            if !selected.iter().any(|lang| lang.code() == code) {
                remove(&self.cache_dir.join(&name)).await;
            }
        }
        let dropped: Vec<OcrLanguage> = {
            let live = self.lock();
            live.verified
                .iter()
                .chain(live.statuses.keys())
                .filter(|lang| !selected.contains(lang))
                .copied()
                .collect()
        };
        for lang in dropped {
            self.publish(|live| {
                live.verified.remove(&lang);
                live.statuses.remove(&lang);
            });
        }

        for lang in selected {
            let waiting = matches!(
                self.status_of(&self.lock(), lang),
                OcrLanguageStatus::Downloading { .. }
            );
            let Some(pin) = self.pin(lang).filter(|_| waiting) else {
                continue;
            };
            if !self.selected().contains(&lang) {
                continue;
            }
            if names.contains(&lang.file_name()) && self.matches_pin(lang, pin).await {
                self.publish(|live| {
                    live.verified.insert(lang);
                });
                continue;
            }
            self.download(lang, pin).await;
        }
    }

    async fn matches_pin(&self, lang: OcrLanguage, pin: Pin) -> bool {
        let path = self.dir.join(lang.file_name());
        match tokio::fs::read(&path).await {
            Ok(bytes) => {
                bytes.len() as u64 == pin.bytes && hex::encode(Sha256::digest(&bytes)) == pin.sha256
            }
            Err(error) => {
                tracing::warn!(
                    scope = "OcrLanguages",
                    lang = lang.code(),
                    "could not read OCR language data: {error}"
                );
                false
            }
        }
    }

    async fn download(&self, lang: OcrLanguage, pin: Pin) {
        let token = CancellationToken::new();
        *self.download.lock().unwrap_or_else(PoisonError::into_inner) = Some((lang, token.clone()));
        let outcome = tokio::select! {
            outcome = self.fetch_verified(lang, pin) => Some(outcome),
            () = token.cancelled() => None,
        };
        *self.download.lock().unwrap_or_else(PoisonError::into_inner) = None;
        match outcome {
            None => self.set_status(lang, None),
            Some(Ok(())) => {
                self.publish(|live| {
                    live.verified.insert(lang);
                    live.statuses.remove(&lang);
                });
                tracing::info!(
                    scope = "OcrLanguages",
                    lang = lang.code(),
                    "OCR language downloaded"
                );
            }
            Some(Err(failure)) => self.set_status(
                lang,
                Some(OcrLanguageStatus::Failed {
                    error: failure.key().to_owned(),
                }),
            ),
        }
    }

    /// English first, then the user's choice, or the app language until they choose.
    fn selected(&self) -> Vec<OcrLanguage> {
        let chosen = match self.config.ocr_languages() {
            Some(codes) => codes
                .iter()
                .filter_map(|code| OcrLanguage::from_code(code))
                .collect(),
            None => {
                vec![OcrLanguage::for_locale(self.locale.get()).unwrap_or(OcrLanguage::BUNDLED)]
            }
        };
        let mut selected = vec![OcrLanguage::BUNDLED];
        for lang in chosen {
            if !selected.contains(&lang) {
                selected.push(lang);
            }
        }
        selected
    }

    fn pin(&self, lang: OcrLanguage) -> Option<Pin> {
        self.pins
            .iter()
            .find(|(pinned, _)| *pinned == lang)
            .map(|(_, pin)| *pin)
    }

    fn status_of(&self, live: &Live, lang: OcrLanguage) -> OcrLanguageStatus {
        if lang == OcrLanguage::BUNDLED || live.verified.contains(&lang) {
            return OcrLanguageStatus::Ready;
        }
        if let Some(status) = live.statuses.get(&lang) {
            return status.clone();
        }
        match self.pin(lang) {
            Some(pin) => OcrLanguageStatus::Downloading {
                received_bytes: 0,
                total_bytes: pin.bytes,
            },
            None => OcrLanguageStatus::Failed {
                error: download::Failure::Unavailable.key().to_owned(),
            },
        }
    }

    fn state_of(&self, live: &Live) -> OcrLanguagesState {
        let selected = self.selected();
        let statuses = selected
            .iter()
            .map(|lang| (*lang, self.status_of(live, *lang)))
            .collect();
        OcrLanguagesState { selected, statuses }
    }

    fn lock(&self) -> MutexGuard<'_, Live> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Applies a change and tells the windows.
    fn publish(&self, change: impl FnOnce(&mut Live)) {
        let mut live = self.lock();
        change(&mut live);
        (self.on_change)(self.state_of(&live));
    }

    fn set_status(&self, lang: OcrLanguage, status: Option<OcrLanguageStatus>) {
        self.publish(|live| match status {
            Some(status) => {
                live.statuses.insert(lang, status);
            }
            None => {
                live.statuses.remove(&lang);
            }
        });
    }
}

/// The names in `dir`; none when it cannot be read (it does not exist before the first download).
async fn file_names(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return names;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_owned());
        }
    }
    names
}

async fn remove(path: &Path) {
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(
            scope = "OcrLanguages",
            "could not delete {}: {error}",
            path.display()
        ),
    }
}
