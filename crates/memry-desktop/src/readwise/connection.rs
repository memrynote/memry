//! The Readwise page's operations on the open vault's run service (`connection.ts`, and the
//! option write of `settings.ts`): the status, connect, disconnect, Sync now from an async
//! caller, the synced options and the error toast's once-per-episode claim. Shapes are the
//! contract's (`ReadwiseStatusResult`, `ReadwiseSetOptionsSchema` in `import-channels.ts`).
//!
//! Blocking, except [`ReadwiseRuns::connect`] and [`ReadwiseRuns::sync_now_async`]: every other
//! call reads the data DB or the keychain, so callers on the async runtime use a blocking task.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::claim::{Claim, clear_claim};
use super::client::{ReadwiseError, ReadwiseErrorKind};
use super::cursor::iso;
use super::options::ReadwiseOptions;
use super::pull_gate::{Authority, PullGateError, authority};
use super::run_state::{Attention, LastRun, RunCounts, RunState};
use super::run_status::{RunFailure, Stage};
use super::run_types::{RunError, RunResult};
use super::scheduler::{Cadence, ReadwiseRuns, SyncNowError};
use super::telemetry::{ConnectSource, connected, disconnected};
use super::token::ConnectError;
use super::types::{FolderLayout, ReadwiseCategory};

/// `ReadwiseFolderLayout`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ReadwiseFolderLayout {
    ByCategory,
    Flat,
}

/// `ReadwiseCadence`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ReadwiseCadence {
    Manual,
    Hourly,
    Daily,
}

/// `Record<ReadwiseCategory, boolean>`, defaults filled in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct ReadwiseCategories {
    pub books: bool,
    pub articles: bool,
    pub tweets: bool,
    pub podcasts: bool,
    pub supplementals: bool,
}

/// `ReadwiseOptions` (`readReadwiseOptions`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadwiseOptionsView {
    pub root_folder: String,
    pub folder_layout: ReadwiseFolderLayout,
    pub categories: ReadwiseCategories,
    pub cadence: ReadwiseCadence,
    pub reader_documents: bool,
    pub reader_full_text: bool,
    pub journal_highlights: bool,
}

/// `ReadwiseRunProgress.stage`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ReadwiseRunStage {
    WaitingForSync,
    Reading,
    Writing,
}

/// `ReadwiseRunProgress`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct ReadwiseRunProgress {
    pub stage: ReadwiseRunStage,
    pub planned: Option<u64>,
    pub done: u64,
}

/// `ReadwiseErrorKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ReadwiseRunErrorKind {
    InvalidToken,
    SubscriptionExpired,
    RateLimited,
    Network,
    Server,
    Unexpected,
}

/// `ReadwiseRunError`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct ReadwiseRunError {
    pub kind: ReadwiseRunErrorKind,
    pub detail: Option<String>,
}

/// `ReadwiseRunCounts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct ReadwiseRunCounts {
    pub books: u64,
    pub added: u64,
    pub updated: u64,
    pub appended: u64,
    pub deferred: u64,
    pub failed: u64,
    pub highlights: u64,
}

/// `ReadwiseStatusResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadwiseStatus {
    pub connected: bool,
    pub options: ReadwiseOptionsView,
    pub last_sync_at: Option<String>,
    pub needs_attention: bool,
    pub has_imported: bool,
    pub this_device_pulls: bool,
    pub pulling_device_name: Option<String>,
    pub syncing: Option<ReadwiseRunProgress>,
    pub last_run: Option<ReadwiseRunCounts>,
    pub error: Option<ReadwiseRunError>,
    pub next_run_at: Option<String>,
}

/// `ReadwiseSetOptionsSchema.categories`.
#[derive(Debug, Clone, Copy, Default, Deserialize, specta::Type)]
pub struct ReadwiseCategoriesInput {
    pub books: Option<bool>,
    pub articles: Option<bool>,
    pub tweets: Option<bool>,
    pub podcasts: Option<bool>,
    pub supplementals: Option<bool>,
}

/// `ReadwiseSetOptionsInput`.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadwiseOptionsInput {
    pub root_folder: Option<String>,
    pub folder_layout: Option<ReadwiseFolderLayout>,
    pub categories: Option<ReadwiseCategoriesInput>,
    pub cadence: Option<ReadwiseCadence>,
    pub reader_documents: Option<bool>,
    pub reader_full_text: Option<bool>,
    pub journal_highlights: Option<bool>,
}

/// The sentence a failure reaches the user as (`describeReadwiseError`, `syncReadwiseNow`):
/// an `errors:` key, the claim holder's sentence, or the failure's own text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sentence {
    Key(&'static str),
    /// `errors:importer.readwiseSyncsOnDevice`; `None` reads as "another device".
    SyncsOnDevice(Option<String>),
    Raw(String),
}

/// Why connect did not store the token.
#[derive(Debug, thiserror::Error)]
pub enum ConnectFailure {
    /// Another device pulls: this one takes over instead (D8).
    #[error("Readwise syncs on another device")]
    Elsewhere(Option<String>),
    #[error(transparent)]
    Token(#[from] ConnectError),
    #[error("{0}")]
    Failed(String),
}

/// A malformed option (`ReadwiseRootFolderSchema`) or a failed write.
#[derive(Debug, thiserror::Error)]
pub enum OptionsError {
    #[error("Invalid folder path")]
    InvalidRoot,
    #[error("{0}")]
    Failed(String),
}

fn failed(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// `describeReadwiseError` for a gate refusal or a Readwise failure, `None` for anything else.
pub fn run_error_sentence(error: &RunError) -> Option<Sentence> {
    match error {
        RunError::Gate(PullGateError::Elsewhere(name)) => {
            Some(Sentence::SyncsOnDevice(name.clone()))
        }
        RunError::Gate(PullGateError::NeedsSync) => {
            Some(Sentence::Key("errors:importer.readwiseNeedsSync"))
        }
        RunError::Gate(PullGateError::ClaimNotDelivered) => {
            Some(Sentence::Key("errors:importer.readwiseClaimNotDelivered"))
        }
        RunError::Gate(PullGateError::NotReady) => {
            Some(Sentence::Key("errors:importer.readwiseNotReady"))
        }
        RunError::Readwise(error) => Some(readwise_sentence(error)),
        RunError::AlreadyRunning | RunError::Failed(_) => None,
    }
}

fn readwise_sentence(error: &ReadwiseError) -> Sentence {
    Sentence::Key(match error.kind() {
        Some(ReadwiseErrorKind::InvalidToken) => "errors:importer.readwiseInvalidToken",
        Some(ReadwiseErrorKind::RateLimited) => "errors:importer.readwiseRateLimited",
        _ => "errors:importer.readwiseUnreachable",
    })
}

/// `syncReadwiseNow`'s sentences.
pub fn sync_now_sentence(error: &SyncNowError) -> Sentence {
    match error {
        SyncNowError::InProgress => Sentence::Key("errors:importer.readwiseRunInProgress"),
        SyncNowError::NotConnected => Sentence::Key("errors:importer.readwiseNotConnected"),
        SyncNowError::OtherDevice | SyncNowError::Closing => {
            Sentence::Key("errors:importer.readwiseRunUnavailable")
        }
        SyncNowError::Keychain(error) => Sentence::Raw(error.to_string()),
        SyncNowError::Run(error) => {
            run_error_sentence(error).unwrap_or_else(|| Sentence::Raw(error.to_string()))
        }
    }
}

/// `verifyPastedToken` and the elsewhere refusal (`withUserMessage`).
pub fn connect_sentence(error: &ConnectFailure) -> Sentence {
    match error {
        ConnectFailure::Elsewhere(name) => Sentence::SyncsOnDevice(name.clone()),
        ConnectFailure::Token(ConnectError::Readwise(error)) => readwise_sentence(error),
        ConnectFailure::Token(error) => Sentence::Raw(error.to_string()),
        ConnectFailure::Failed(error) => Sentence::Raw(error.clone()),
    }
}

fn options_view(group: &Value) -> ReadwiseOptionsView {
    let options = ReadwiseOptions::from_group(group);
    let on = |category| options.categories.get(category).unwrap_or(true);
    ReadwiseOptionsView {
        root_folder: options.root_folder,
        folder_layout: match options.folder_layout {
            FolderLayout::Flat => ReadwiseFolderLayout::Flat,
            FolderLayout::ByCategory => ReadwiseFolderLayout::ByCategory,
        },
        categories: ReadwiseCategories {
            books: on(ReadwiseCategory::Books),
            articles: on(ReadwiseCategory::Articles),
            tweets: on(ReadwiseCategory::Tweets),
            podcasts: on(ReadwiseCategory::Podcasts),
            supplementals: options
                .categories
                .get(ReadwiseCategory::Supplementals)
                .unwrap_or(false),
        },
        cadence: match Cadence::from_group(group) {
            Cadence::Manual => ReadwiseCadence::Manual,
            Cadence::Hourly => ReadwiseCadence::Hourly,
            Cadence::Daily => ReadwiseCadence::Daily,
        },
        reader_documents: options.reader_documents,
        reader_full_text: group.get("readerFullText").and_then(Value::as_bool) == Some(true),
        journal_highlights: options.journal_highlights,
    }
}

fn failure_view(failure: RunFailure) -> ReadwiseRunError {
    use ReadwiseRunErrorKind as K;
    let kind = match failure.kind {
        "invalid-token" => K::InvalidToken,
        "subscription-expired" => K::SubscriptionExpired,
        "rate-limited" => K::RateLimited,
        "network" => K::Network,
        "server" => K::Server,
        _ => K::Unexpected,
    };
    ReadwiseRunError {
        kind,
        detail: failure.detail,
    }
}

fn counts_view(c: RunCounts) -> ReadwiseRunCounts {
    ReadwiseRunCounts {
        books: c.books,
        added: c.added,
        updated: c.updated,
        appended: c.appended,
        deferred: c.deferred,
        failed: c.failed,
        highlights: c.highlights,
    }
}

/// `ReadwiseRootFolderSchema`: trimmed, outer slashes dropped, no empty, `.` or `..` segment.
fn root_folder(raw: &str) -> Result<String, OptionsError> {
    let root = raw.trim().trim_matches('/');
    let valid = !root.is_empty() && root.split('/').all(|part| !matches!(part, "" | "." | ".."));
    valid
        .then(|| root.to_owned())
        .ok_or(OptionsError::InvalidRoot)
}

fn kebab<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

impl ReadwiseRuns {
    fn authority_now(&self) -> Result<Authority, String> {
        let claim = Claim::read(&self.library().store()).map_err(failed)?;
        Ok(authority(&self.parts().sync.env(), &claim))
    }

    /// `getReadwiseStatus`.
    pub fn status_view(&self) -> Result<ReadwiseStatus, String> {
        let store = self.library().store();
        let connected = self.parts().token.read().map_err(failed)?.is_some();
        let state = RunState::new(self.library().store());
        let last_run = if connected {
            state.last_run().map_err(failed)?
        } else {
            None
        };
        let elsewhere = match self.authority_now()? {
            Authority::Elsewhere(name) => Some(name),
            _ => None,
        };
        // A value an older build wrote has no kind: it parked on a revoked token.
        let parked = last_run
            .as_ref()
            .filter(|run| run.needs_attention)
            .map(|run| ReadwiseRunError {
                kind: match run.attention {
                    Some(Attention::SubscriptionExpired) => {
                        ReadwiseRunErrorKind::SubscriptionExpired
                    }
                    Some(Attention::InvalidToken) | None => ReadwiseRunErrorKind::InvalidToken,
                },
                detail: None,
            });
        let next_run_at = match (connected && elsewhere.is_none())
            .then(|| self.next_run_at())
            .flatten()
        {
            Some(at) => Some(iso(at).map_err(failed)?),
            None => None,
        };
        let progress = self.status().progress().filter(|_| connected);
        Ok(ReadwiseStatus {
            connected,
            options: options_view(&store.settings_group().map_err(failed)?),
            last_sync_at: last_run.as_ref().map(|run| run.at.clone()),
            needs_attention: last_run.as_ref().is_some_and(|run| run.needs_attention),
            has_imported: state.cursor().map_err(failed)?.is_some(),
            this_device_pulls: elsewhere.is_none(),
            pulling_device_name: elsewhere.flatten(),
            syncing: progress.map(|p| ReadwiseRunProgress {
                stage: match p.stage {
                    Stage::WaitingForSync => ReadwiseRunStage::WaitingForSync,
                    Stage::Reading => ReadwiseRunStage::Reading,
                    Stage::Writing => ReadwiseRunStage::Writing,
                },
                planned: p.planned,
                done: p.done,
            }),
            last_run: last_run
                .as_ref()
                .and_then(|run| run.counts)
                .map(counts_view),
            error: if connected {
                parked.or_else(|| self.status().failure().map(failure_view))
            } else {
                None
            },
            next_run_at,
        })
    }

    /// `connectReadwise`: refused while another device pulls; the pasted token is checked with
    /// Readwise before anything is stored, and a fresh token ends "needs attention". The first
    /// run writes the claim (`claimThisDevice` there).
    pub async fn connect(
        self: &Arc<Self>,
        pasted: String,
    ) -> Result<ReadwiseStatus, ConnectFailure> {
        let outcome = self.connect_untracked(pasted).await;
        // One `readwise_connected` per attempt, with the failure's code (`trackConnect`).
        let event = match &outcome {
            Ok(_) => connected(ConnectSource::Token, None),
            Err(ConnectFailure::Token(ConnectError::Readwise(error))) => {
                connected(ConnectSource::Token, Some(error))
            }
            Err(failure) => {
                let mut event = connected(ConnectSource::Token, None);
                event.result = Some("failed".to_owned());
                event.error_code = Some(match failure {
                    ConnectFailure::Elsewhere(_) => "elsewhere".to_owned(),
                    _ => "unexpected".to_owned(),
                });
                event
            }
        };
        (self.parts().track)(event);
        outcome
    }

    async fn connect_untracked(
        self: &Arc<Self>,
        pasted: String,
    ) -> Result<ReadwiseStatus, ConnectFailure> {
        let runs = Arc::clone(self);
        let authority = tokio::task::spawn_blocking(move || runs.authority_now())
            .await
            .map_err(failed)
            .and_then(|read| read)
            .map_err(ConnectFailure::Failed)?;
        if let Authority::Elsewhere(name) = authority {
            return Err(ConnectFailure::Elsewhere(name));
        }
        let parts = self.parts();
        parts
            .token
            .connect(&parts.client, &pasted, &CancellationToken::new())
            .await?;
        let runs = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let state = RunState::new(runs.library().store());
            if let Some(run) = state.last_run().map_err(failed)?
                && run.needs_attention
            {
                let cleared = LastRun {
                    at: run.at,
                    needs_attention: false,
                    attention: None,
                    counts: run.counts,
                };
                state.set_last_run(&cleared).map_err(failed)?;
            }
            runs.status().clear_failure();
            runs.status_view()
        })
        .await
        .map_err(failed)
        .and_then(|status| status)
        .map_err(ConnectFailure::Failed)
    }

    /// `disconnectReadwise`: the token and the run state go, every note stays (D9). Only the
    /// pulling device's disconnect frees the claim.
    pub fn disconnect(&self) -> Result<(), String> {
        let library = self.library();
        let store = library.store();
        self.parts().token.disconnect().map_err(failed)?;
        store.clear_run_state().map_err(failed)?;
        self.status().clear_failure();
        let claim = Claim::read(&store).map_err(failed)?;
        if claim.device_id == self.parts().sync.env().device_id {
            let settings = (library.open.vault)
                .settings(library.notes.store.clone())
                .map_err(failed)?;
            clear_claim(&store, &settings).map_err(failed)?;
        }
        (self.parts().track)(disconnected());
        Ok(())
    }

    /// Sync now from an async caller: the run blocks (the keychain, the data DB and the run's
    /// own `block_on`), so it runs on a blocking thread, never on a runtime worker.
    pub async fn sync_now_async(self: Arc<Self>) -> Result<RunResult, SyncNowError> {
        tokio::task::spawn_blocking(move || self.sync_now())
            .await
            .unwrap_or_else(|error| {
                let error = RunError::Failed(format!("the Readwise run did not finish: {error}"));
                Err(SyncNowError::Run(Arc::new(error)))
            })
    }

    /// `writeReadwiseOptions`: one synced leaf per given option, so another device's change
    /// to a different option merges (§13.4).
    pub fn set_options(&self, input: &ReadwiseOptionsInput) -> Result<(), OptionsError> {
        let mut leaves: Vec<(String, Value)> = Vec::new();
        if let Some(root) = &input.root_folder {
            leaves.push(("rootFolder".into(), Value::String(root_folder(root)?)));
        }
        if let Some(layout) = input.folder_layout {
            leaves.push(("folderLayout".into(), kebab(layout)));
        }
        if let Some(cadence) = input.cadence {
            leaves.push(("cadence".into(), kebab(cadence)));
        }
        let flags = [
            ("readerDocuments", input.reader_documents),
            ("readerFullText", input.reader_full_text),
            ("journalHighlights", input.journal_highlights),
        ];
        for (name, value) in flags {
            if let Some(value) = value {
                leaves.push((name.into(), Value::Bool(value)));
            }
        }
        if let Some(c) = input.categories {
            let categories = [
                ("books", c.books),
                ("articles", c.articles),
                ("tweets", c.tweets),
                ("podcasts", c.podcasts),
                ("supplementals", c.supplementals),
            ];
            for (name, value) in categories {
                if let Some(value) = value {
                    leaves.push((format!("categories.{name}"), Value::Bool(value)));
                }
            }
        }
        let library = self.library();
        let settings = (library.open.vault)
            .settings(library.notes.store.clone())
            .map_err(|e| OptionsError::Failed(e.to_string()))?;
        for (leaf, value) in leaves {
            settings
                .set(format!("readwise.{leaf}"), value.to_string())
                .map_err(|e| OptionsError::Failed(e.to_string()))?;
        }
        Ok(())
    }

    /// `claimErrorToast`: true once per parked episode, for the one toast of the error.
    pub fn ack_error_toast(&self) -> Result<bool, String> {
        RunState::new(self.library().store())
            .claim_error_toast()
            .map_err(failed)
    }
}
