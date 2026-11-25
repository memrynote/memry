//! The voice memo embedding lane (Step 24 stage C2, #3541), after Electron's
//! `voice-embedding-projector.ts`, on a real vault, inbox and index with a fake model.
//!
//! | Test                                                  | Rule                                |
//! | ----------------------------------------------------- | ----------------------------------- |
//! | a transcribed memo is embedded from its transcript    | `planVoiceEmbedding`, `embedItem`   |
//! | a failed memo is embedded from its recording          | `embedItem` audio path, `embedAudio`|
//! | audio search off, a webm memo, a pending memo: none   | `isAudioEmbeddingEnabled`, `wait`   |
//! | AI off and a deleted memo drop the vectors            | `project`, :145-153                 |
//! | the reconcile embeds owed memos and prunes gone ones  | `reconcile`, :170-197               |
//! | a second reconcile embeds nothing already embedded    | `reconcile`, :186-191               |
//! | an upper-case `.WAV` name is embedded from its audio  | `readRecording`, :96                |
//! | the worker gets the recording's real path, no link    | departure: path handed to a child   |

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::inbox::Inbox;
use memry_core::domain::embedding_input::UNCAPPED_EMBEDDING_INPUT_VERSION;
use memry_core::domain::inbox::enrich::VoiceMemoName;
use memry_core::domain::voice_embeddings::{
    AUDIO_EMBEDDING_INPUT_VERSION, VoiceEmbeddingState, VoiceSource,
};
use memry_desktop::embedding::download::Abort;
use memry_desktop::embedding::service::{
    AudioOpened, EMBEDDING_DIMENSION, EmbedError, EmbeddingService, Engine, ModelLoader,
    ModelProgress, Timing,
};
use memry_desktop::embedding::voice_projector::{self, VoiceEmbeddingProjector, notify_voice};
use memry_desktop::session::projection::{CancelToken, ProjectionEvent, Projector, feed};

use crate::device_key::with_device_key;
use crate::vault_env::{Env, WAIT, env};

#[derive(Default)]
struct Model {
    texts: Mutex<Vec<String>>,
    recordings: Mutex<Vec<PathBuf>>,
    windows: AtomicU32,
}

struct FakeEngine(Arc<Model>);

impl Engine for FakeEngine {
    fn embed_text(&mut self, text: &str) -> Result<Vec<f32>, EmbedError> {
        self.0.texts.lock().unwrap().push(text.to_owned());
        Ok(vec![0.5; EMBEDDING_DIMENSION])
    }

    fn open_audio(&mut self, path: &std::path::Path) -> Result<AudioOpened, EmbedError> {
        self.0.recordings.lock().unwrap().push(path.to_path_buf());
        Ok(AudioOpened {
            recording: 1,
            windows: self.0.windows.load(Ordering::SeqCst),
        })
    }

    fn embed_audio_window(&mut self, _: u64, window: u32) -> Result<Vec<f32>, EmbedError> {
        let mut vector = vec![0.0; EMBEDDING_DIMENSION];
        vector[window as usize] = 1.0;
        Ok(vector)
    }
}

struct Loader(Arc<Model>);

impl ModelLoader for Loader {
    fn load(
        &self,
        _: &Abort,
        _: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<Box<dyn Engine>, String> {
        Ok(Box::new(FakeEngine(self.0.clone())))
    }
}

struct Lane {
    e: Env,
    projector: Arc<VoiceEmbeddingProjector>,
    model: Arc<Model>,
    ai: Arc<AtomicBool>,
    audio: Arc<AtomicBool>,
    inbox: Arc<Inbox>,
}

fn lane() -> Lane {
    let mut e = env(|_| None);
    let model = Arc::new(Model::default());
    model.windows.store(1, Ordering::SeqCst);
    let service = EmbeddingService::new(
        Arc::new(Loader(model.clone())),
        Arc::new(|_| {}),
        Timing::default(),
    );
    let (ai, audio) = (
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicBool::new(true)),
    );
    let projector = VoiceEmbeddingProjector::new(
        &e.session,
        service.clone(),
        {
            let ai = ai.clone();
            Arc::new(move |_| ai.load(Ordering::SeqCst))
        },
        {
            let (ai, audio) = (ai.clone(), audio.clone());
            Arc::new(move |_| ai.load(Ordering::SeqCst) && audio.load(Ordering::SeqCst))
        },
    );
    e.session.register_projector(projector.clone());
    service.register(&e.session);
    e.open();
    let inbox = e.core.as_ref().unwrap().inbox(with_device_key()).unwrap();
    Lane {
        e,
        projector,
        model,
        ai,
        audio,
        inbox,
    }
}

impl Lane {
    /// A voice memo with its recording in the vault, its transcription `pending`.
    fn memo(&self, ext: &str) -> String {
        let id = self.inbox.new_id();
        self.memo_at(
            &id,
            &format!("attachments/inbox/{id}/voice-memo.{ext}"),
            ext,
        )
    }

    fn memo_at(&self, id: &str, rel: &str, ext: &str) -> String {
        let id = id.to_owned();
        let rel = rel.to_owned();
        self.e.write(&rel, "RIFF");
        self.inbox
            .capture_voice(
                id.clone(),
                7.0,
                ext.into(),
                4,
                rel,
                vec![],
                Some("pending".into()),
                None,
            )
            .unwrap();
        id
    }

    fn transcribed(&self, transcript: &str) -> String {
        let id = self.memo("wav");
        self.inbox
            .complete_transcription(id.clone(), transcript.into(), VoiceMemoName::Keep)
            .unwrap();
        id
    }

    fn failed(&self, ext: &str) -> String {
        let id = self.memo(ext);
        self.inbox
            .fail_transcription(id.clone(), "Rate limit exceeded".into())
            .unwrap();
        id
    }

    fn notify(&self, id: &str) {
        notify_voice(&self.e.session, id.to_owned());
    }

    /// Events reach the lane in order: once a memo published after `ids` is embedded, the lane
    /// has handled every one of them.
    fn after(&self, ids: &[&str]) {
        for id in ids {
            self.notify(id);
        }
        let sentinel = self.transcribed("the lane caught up");
        self.notify(&sentinel);
        self.until("the sentinel memo", |l| l.row(&sentinel).is_some());
    }

    fn rows(&self) -> Vec<VoiceEmbeddingState> {
        let search = self.e.session.current().expect("open").search;
        search.voice_embedding_state().unwrap()
    }

    fn row(&self, id: &str) -> Option<VoiceEmbeddingState> {
        self.rows().into_iter().find(|row| row.item_id == id)
    }

    fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done(self) {
            assert!(Instant::now() < deadline, "still waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn a_transcribed_memo_is_embedded_from_its_transcript() {
    let l = lane();
    let id = l.transcribed("buy oat milk today");
    l.notify(&id);
    l.until("the transcript vector", |l| l.row(&id).is_some());
    assert_eq!(
        l.row(&id).unwrap(),
        VoiceEmbeddingState {
            item_id: id.clone(),
            source: "transcript".into(),
            input_version: UNCAPPED_EMBEDDING_INPUT_VERSION,
            chunks: 1,
        }
    );
    let texts = l.model.texts.lock().unwrap().clone();
    assert!(
        texts.iter().any(|text| text.contains("buy oat milk today")),
        "{texts:?}"
    );
    assert!(l.model.recordings.lock().unwrap().is_empty());
}

#[test]
fn a_failed_memo_is_embedded_from_its_recording_and_found_by_search() {
    let l = lane();
    l.model.windows.store(3, Ordering::SeqCst);
    let id = l.failed("wav");
    l.notify(&id);
    l.until("the audio vectors", |l| l.row(&id).is_some());
    assert_eq!(
        l.row(&id).unwrap(),
        VoiceEmbeddingState {
            item_id: id.clone(),
            source: VoiceSource::Audio.as_str().into(),
            input_version: AUDIO_EMBEDDING_INPUT_VERSION,
            chunks: 3,
        }
    );
    let recordings = l.model.recordings.lock().unwrap().clone();
    assert_eq!(recordings.len(), 1);
    let vault = std::fs::canonicalize(&l.e.vault).unwrap();
    assert!(recordings[0].starts_with(&vault), "{recordings:?}");
    assert!(recordings[0].ends_with(format!("{id}/voice-memo.wav")));

    // The search's voice leg reads what the lane stored: the third window answers.
    let search = l.e.session.current().expect("open").search;
    let mut query = vec![0.0; EMBEDDING_DIMENSION];
    query[2] = 1.0;
    let hits = search.semantic_note_hits(&query, false).unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0].id, id);
}

#[test]
fn audio_search_off_a_webm_memo_and_a_pending_memo_embed_nothing() {
    let l = lane();
    l.audio.store(false, Ordering::SeqCst);
    let quiet = l.failed("wav");
    l.after(&[&quiet]);
    assert_eq!(l.row(&quiet), None);

    l.audio.store(true, Ordering::SeqCst);
    let webm = l.failed("webm");
    let pending = l.memo("wav");
    l.after(&[&webm, &pending]);
    assert_eq!(l.row(&webm), None);
    assert_eq!(l.row(&pending), None);
    assert!(l.model.recordings.lock().unwrap().is_empty());
}

#[test]
fn ai_off_and_a_deleted_memo_drop_the_vectors() {
    let l = lane();
    let (kept, deleted) = (l.transcribed("one two three"), l.failed("wav"));
    l.after(&[&kept, &deleted]);
    assert!(l.row(&kept).is_some() && l.row(&deleted).is_some());

    feed::publish(
        &l.e.session,
        ProjectionEvent::InboxDeleted {
            item_id: deleted.clone(),
        },
    );
    l.until("the deleted memo's vectors gone", |l| {
        l.row(&deleted).is_none()
    });

    l.ai.store(false, Ordering::SeqCst);
    l.notify(&kept);
    l.until("AI off drops the vectors", |l| l.row(&kept).is_none());
}

#[test]
fn the_reconcile_embeds_owed_memos_and_prunes_gone_ones() {
    let l = lane();
    let owed = l.transcribed("call the bank tomorrow");
    let search = l.e.session.current().expect("open").search;
    search
        .store_voice_embeddings(
            "gone".into(),
            VoiceSource::Audio,
            vec![vec![0.5; EMBEDDING_DIMENSION]],
        )
        .unwrap();
    // An older input version is owed again.
    let stale = l.transcribed("pick up the parcel");
    search
        .index_handle()
        .call_blocking({
            let stale = stale.clone();
            move |conn| {
                conn.execute(
                    "INSERT INTO voice_embedding_state VALUES (?1, 'transcript', 1, 0)",
                    [&stale],
                )
                .unwrap();
                Ok(())
            }
        })
        .unwrap();

    let runtime = l.e.session.projections().expect("open");
    runtime.reconcile_named(&[voice_projector::NAME]).unwrap();
    l.until("the reconcile", |l| {
        l.row("gone").is_none()
            && l.row(&owed).is_some()
            && l.row(&stale)
                .is_some_and(|row| row.input_version == UNCAPPED_EMBEDDING_INPUT_VERSION)
    });
}

/// `reconcile` skips a memo whose state row names the source its plan picks at the current
/// input version: neither the transcript nor the three audio windows are embedded again.
#[test]
fn a_second_reconcile_embeds_nothing_already_embedded() {
    let l = lane();
    l.model.windows.store(3, Ordering::SeqCst);
    let (spoken, recorded) = (l.transcribed("buy oat milk today"), l.failed("wav"));
    l.after(&[&spoken, &recorded]);
    assert_eq!(l.row(&spoken).unwrap().source, "transcript");
    assert_eq!(l.row(&recorded).unwrap().chunks, 3);
    l.model.texts.lock().unwrap().clear();
    l.model.recordings.lock().unwrap().clear();

    // On the test's thread, so the pass is over when it returns; the lane is idle.
    l.projector.reconcile(&CancelToken::default()).unwrap();
    assert!(l.model.texts.lock().unwrap().is_empty());
    assert!(l.model.recordings.lock().unwrap().is_empty());
}

/// `readRecording` lower-cases the name before the `.wav` check.
#[test]
fn an_upper_case_wav_name_is_embedded_from_its_audio() {
    let l = lane();
    let id = l.inbox.new_id();
    l.memo_at(
        &id,
        &format!("attachments/inbox/{id}/voice-memo.WAV"),
        "wav",
    );
    l.inbox
        .fail_transcription(id.clone(), "Rate limit exceeded".into())
        .unwrap();
    l.notify(&id);
    l.until("the audio vectors", |l| l.row(&id).is_some());
    assert_eq!(l.row(&id).unwrap().source, "audio");
}

/// The worker opens the recording by path, so it gets the canonical target: a link inside the
/// vault is resolved before the check, not left for the worker to follow afterwards.
#[cfg(unix)]
#[test]
fn the_worker_gets_the_recordings_real_path() {
    let l = lane();
    let id = l.inbox.new_id();
    let real = l.e.vault.join("attachments/real");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::create_dir_all(l.e.vault.join("attachments/inbox")).unwrap();
    std::os::unix::fs::symlink(&real, l.e.vault.join("attachments/inbox/linked")).unwrap();
    l.memo_at(&id, "attachments/inbox/linked/voice-memo.wav", "wav");
    l.inbox
        .fail_transcription(id.clone(), "Rate limit exceeded".into())
        .unwrap();
    l.notify(&id);
    l.until("the audio vectors", |l| l.row(&id).is_some());
    let recordings = l.model.recordings.lock().unwrap().clone();
    let expected = std::fs::canonicalize(real.join("voice-memo.wav")).unwrap();
    assert_eq!(recordings, [expected]);
}
