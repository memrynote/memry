//! The voice memo embedding projector: the `voice-embedding` lane, a port of Electron's
//! `apps/desktop/src/main/projections/projectors/voice-embedding-projector.ts` over
//! [`EmbeddingService::embed`] and [`EmbeddingService::embed_audio`] and the core's voice vector
//! store ([`voice_embeddings`](memry_core::domain::voice_embeddings)).
//!
//! - **Plan** ([`plan`]): a memo with a usable transcript is embedded from its title and
//!   transcript with the text model; any other is embedded from its recording, one vector per
//!   30 s window. A running transcription waits: its outcome publishes the memo again
//!   ([`notify_voice`], from `VoiceService::on_voice_captured`).
//! - **Gated** (`isAIEnabled`, `isAudioEmbeddingEnabled`): the session's cancel token, the vault
//!   still being the one the work started on, and `ai.enabled` before every memo and before every
//!   store; the audio path also `voiceTranscription.audioSearch` and a `.wav` name. An event with
//!   AI off drops the memo's vectors (:150-153).
//! - **Owed lives in `index.db`.** The reconcile embeds every memo whose state row is missing or
//!   names another source or input version, and drops the vectors of memos that are gone
//!   (:170-197). Old vectors keep answering until replaced. A failed embed stores nothing and is
//!   tried again on the next event or vault open; the service's breakers back off a failing
//!   model.
//! - **Departures.** The recording path is confined to the vault before the worker opens it
//!   (Electron's `openVaultFile` does the same in-process). The rebuild refuses with AI off,
//!   where it would delete vectors it cannot restore (as the image lane, Kaan 9 Nov).

use std::path::Path;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::domain::voice_embeddings::{VoiceItem, VoicePlan, VoiceSource, plan};

use super::projector::AiEnabled;
use super::service::EmbeddingService;
use crate::session::projection::{CancelToken, ProjectionEvent, Projector, Rebuilt, feed};
use crate::session::{OpenVault, Session};
use crate::shell::file_open::Resolution;
use crate::vault::paths::resolve_vault_file;

/// The lane's name (`embedding::PROJECTORS[2]`).
pub const NAME: &str = "voice-embedding";

/// Whether `ai.enabled` and `voiceTranscription.audioSearch` are on for the open vault
/// (`isAudioEmbeddingEnabled`); `false` when they cannot be read.
pub type AudioSearch = Arc<dyn Fn(&OpenVault) -> bool + Send + Sync>;

/// `notifyVoice`: the memo changed (its transcription finished or failed), so the voice lane
/// embeds it again. Nothing when no vault is open: the next open's reconcile finds it owed.
pub fn notify_voice(session: &Session, item_id: String) {
    feed::publish(session, ProjectionEvent::InboxUpserted { item_id });
}

pub struct VoiceEmbeddingProjector {
    session: Session,
    service: Arc<EmbeddingService>,
    ai_enabled: AiEnabled,
    audio_search: AudioSearch,
}

struct Work<'a> {
    open: OpenVault,
    cancel: &'a CancelToken,
}

fn text(error: StorageError) -> String {
    error.to_string()
}

impl VoiceEmbeddingProjector {
    pub fn new(
        session: &Session,
        service: Arc<EmbeddingService>,
        ai_enabled: AiEnabled,
        audio_search: AudioSearch,
    ) -> Arc<Self> {
        Arc::new(Self {
            session: session.clone(),
            service,
            ai_enabled,
            audio_search,
        })
    }

    fn work<'a>(&self, cancel: &'a CancelToken) -> Option<Work<'a>> {
        if cancel.is_cancelled() {
            return None;
        }
        Some(Work {
            open: self.session.current()?,
            cancel,
        })
    }

    fn may_embed(&self, work: &Work<'_>) -> bool {
        !work.cancel.is_cancelled()
            && self
                .session
                .current()
                .is_some_and(|open| Arc::ptr_eq(&open.vault, &work.open.vault))
            && (self.ai_enabled)(&work.open)
    }

    /// `embedItem`: whether the memo's vectors were stored as `plan` says.
    fn embed_item(
        &self,
        work: &Work<'_>,
        item: &VoiceItem,
        plan: VoicePlan,
    ) -> Result<bool, String> {
        let (source, vectors) = match plan {
            VoicePlan::Wait => return Ok(false),
            VoicePlan::Transcript(text) => {
                if text.is_empty() || !self.may_embed(work) {
                    return Ok(false);
                }
                let Some(vector) = self.service.embed(&text) else {
                    return Ok(false);
                };
                (VoiceSource::Transcript, vec![vector])
            }
            VoicePlan::Audio => {
                let Some(rel) = item.attachment_path.as_deref() else {
                    return Ok(false);
                };
                if !rel.to_lowercase().ends_with(".wav")
                    || !self.may_embed(work)
                    || !(self.audio_search)(&work.open)
                {
                    return Ok(false);
                }
                let Some(vectors) = self.recording(&work.open.path, rel)? else {
                    return Ok(false);
                };
                (VoiceSource::Audio, vectors)
            }
        };
        if !self.may_embed(work) {
            return Ok(false);
        }
        work.open
            .search
            .store_voice_embeddings(item.id.clone(), source, vectors)
            .map_err(text)?;
        Ok(true)
    }

    /// `readRecording` and `embedAudio`: the recording's window vectors, `None` when it is outside
    /// the vault, missing, under a second, unreadable, or any window failed.
    fn recording(&self, vault: &Path, rel: &str) -> Result<Option<Vec<Vec<f32>>>, String> {
        let Resolution::Inside(path) =
            resolve_vault_file(vault, rel).map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        Ok(self
            .service
            .embed_audio(&path)
            .filter(|vectors| !vectors.is_empty()))
    }

    fn embed_logged(&self, work: &Work<'_>, item: &VoiceItem, plan: VoicePlan) -> bool {
        self.embed_item(work, item, plan).unwrap_or_else(|error| {
            tracing::warn!(
                scope = "Projections:VoiceEmbeddings",
                item_id = item.id,
                %error,
                "Failed to embed voice memo"
            );
            false
        })
    }

    /// `reconcile`'s body: the vectors of memos that are gone dropped, then every memo with no
    /// vectors, or vectors made another way or under another input version, embedded. The
    /// number stored.
    fn sync(&self, work: &Work<'_>) -> Result<u32, String> {
        let search = &work.open.search;
        let items = search.voice_items(None).map_err(text)?;
        let states = search.voice_embedding_state().map_err(text)?;
        for state in &states {
            if !items.iter().any(|item| item.id == state.item_id) {
                search
                    .delete_voice_embeddings(state.item_id.clone())
                    .map_err(text)?;
            }
        }
        let mut computed = 0;
        for item in &items {
            if !self.may_embed(work) {
                break;
            }
            let plan = plan(item);
            let Some(source) = plan.source() else {
                continue;
            };
            let state = states.iter().find(|state| state.item_id == item.id);
            if state.is_some_and(|state| state.matches(source)) {
                continue;
            }
            if self.embed_logged(work, item, plan) {
                computed += 1;
            }
        }
        Ok(computed)
    }
}

impl Projector for VoiceEmbeddingProjector {
    fn name(&self) -> &str {
        NAME
    }

    /// Model loads and encoder runs are slow and nothing reads them back in the same turn.
    fn background(&self) -> bool {
        true
    }

    fn handles(&self, event: &ProjectionEvent) -> bool {
        matches!(
            event,
            ProjectionEvent::InboxUpserted { .. } | ProjectionEvent::InboxDeleted { .. }
        )
    }

    fn project(&self, event: &ProjectionEvent, cancel: &CancelToken) -> Result<(), String> {
        let Some(work) = self.work(cancel) else {
            return Ok(());
        };
        let search = &work.open.search;
        match event {
            ProjectionEvent::InboxDeleted { item_id } => search
                .delete_voice_embeddings(item_id.clone())
                .map_err(text),
            ProjectionEvent::InboxUpserted { item_id } => {
                let Some(item) = search
                    .voice_items(Some(item_id.clone()))
                    .map_err(text)?
                    .pop()
                else {
                    return Ok(());
                };
                if !(self.ai_enabled)(&work.open) {
                    return search.delete_voice_embeddings(item.id).map_err(text);
                }
                self.embed_logged(&work, &item, plan(&item));
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// `rebuild`: every voice vector dropped, then every memo embedded again. Refused with AI
    /// off, where it would delete vectors it cannot restore (Electron clears first).
    fn rebuild(&self, cancel: &CancelToken) -> Result<Rebuilt, String> {
        let Some(work) = self.work(cancel) else {
            return Err("Projector database is no longer current".into());
        };
        if !(self.ai_enabled)(&work.open) {
            return Err("local AI is off".into());
        }
        work.open.search.clear_voice_embeddings().map_err(text)?;
        let computed = self.sync(&work)?;
        Ok(Rebuilt {
            computed,
            skipped: 0,
        })
    }

    fn reconcile(&self, cancel: &CancelToken) -> Result<(), String> {
        let Some(work) = self.work(cancel) else {
            return Ok(());
        };
        self.sync(&work).map(drop)
    }
}
