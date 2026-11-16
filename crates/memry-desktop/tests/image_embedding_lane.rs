//! The image embedding lane (Step 25 lane H2, #3542), after Electron's
//! `image-embedding-projector.ts`, on a real vault and index with a fake model and PDF reader.
//!
//! | Test                                                    | Rule                                  |
//! | ------------------------------------------------------- | ------------------------------------- |
//! | an image with text is embedded interleaved at 280       | `embedOne`, :94-108                   |
//! | a photo with no text is embedded alone                  | `embedOne`, :99-106                   |
//! | a PDF embeds its first eight pages from one open        | `renderPdfPage`, :70-85; listing      |
//! | a pending job waits and images off embed nothing        | `sync`, :128-139                      |
//! | new bytes re-embed, the same bytes do not               | `sync`, :130-137                      |
//! | a deleted note loses its vectors                        | `project`, :170-180                   |
//! | three failures in a row end the pass                    | `MAX_CONSECUTIVE_FAILURES`, :24, 140  |
//! | the reconcile waits for the index build                 | departure: `note_files` half filled   |

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::domain::file_text::{ExtractedTextMethod, JobOutcome, TextSource};
use memry_core::domain::image_embeddings::ImageEmbeddingState;
use memry_desktop::embedding::download::Abort;
use memry_desktop::embedding::image_projector::{self, ImageEmbeddingProjector};
use memry_desktop::embedding::service::{
    EMBEDDING_DIMENSION, EmbedError, EmbeddingService, Engine, ImageInput, ModelLoader,
    ModelProgress, Timing,
};
use memry_desktop::services::file_text::{PdfPages, PdfReader};
use memry_desktop::session::projection::{ProjectionEvent, feed};
use memry_desktop::vault::consumer::Applied;

use crate::vault_env::files_too::files_too;
use crate::vault_env::{Env, WAIT, env, indexed};

#[derive(Default)]
struct Model {
    images: Mutex<Vec<ImageInput>>,
    failing: AtomicBool,
}

struct FakeEngine(Arc<Model>);

impl Engine for FakeEngine {
    fn embed_text(&mut self, _: &str) -> Result<Vec<f32>, EmbedError> {
        Ok(vec![0.5; EMBEDDING_DIMENSION])
    }

    fn embed_image(&mut self, image: &ImageInput) -> Result<Vec<f32>, EmbedError> {
        self.0.images.lock().unwrap().push(image.clone());
        if self.0.failing.load(Ordering::SeqCst) {
            return Err(EmbedError::Failed("not an image".into()));
        }
        Ok(vec![0.25; EMBEDDING_DIMENSION])
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

/// Ten pages each; a page renders as its number.
#[derive(Default)]
struct FakePdf {
    opens: AtomicUsize,
    renders: Mutex<Vec<(u32, u32)>>,
}

struct Doc<'a>(&'a FakePdf);

impl PdfReader for FakePdf {
    fn open(&self, path: &Path) -> Result<Box<dyn PdfPages + '_>, String> {
        assert!(path.is_absolute(), "{}", path.display());
        self.opens.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(Doc(self)))
    }

    fn release(&self) {}
}

impl PdfPages for Doc<'_> {
    fn page_count(&self) -> u32 {
        10
    }

    fn page_text(&self, _: u32) -> Result<String, String> {
        Ok(String::new())
    }

    fn render_page(&self, page: u32, max_edge: u32) -> Result<Vec<u8>, String> {
        self.0.renders.lock().unwrap().push((page, max_edge));
        Ok(vec![page as u8; 4])
    }

    fn close(self: Box<Self>) -> Result<(), String> {
        Ok(())
    }
}

struct Lane {
    e: Env,
    model: Arc<Model>,
    pdf: Arc<FakePdf>,
    on: Arc<AtomicBool>,
    indexing: Arc<AtomicBool>,
}

fn lane(timing: Timing) -> Lane {
    let mut e = env(|store| Some(files_too(store)));
    let model = Arc::new(Model::default());
    let service = EmbeddingService::new(Arc::new(Loader(model.clone())), Arc::new(|_| {}), timing);
    let pdf = Arc::new(FakePdf::default());
    let (on, indexing) = (
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicBool::new(false)),
    );
    let projector = ImageEmbeddingProjector::new(
        &e.session,
        service.clone(),
        pdf.clone(),
        {
            let on = on.clone();
            Arc::new(move |_| on.load(Ordering::SeqCst))
        },
        {
            let indexing = indexing.clone();
            Arc::new(move || indexing.load(Ordering::SeqCst))
        },
    );
    e.session.register_projector(projector);
    service.register(&e.session);
    feed::watch(&e.session, e.tier.subscribe()).unwrap();
    e.open();
    e.facts_until(indexed);
    e.watcher_live();
    Lane {
        e,
        model,
        pdf,
        on,
        indexing,
    }
}

fn of(note_id: &str, source: &str) -> TextSource {
    TextSource {
        note_id: note_id.to_owned(),
        source: source.to_owned(),
    }
}

impl Lane {
    fn write(&mut self, rel: &str, text: &str) -> String {
        self.e.write(rel, text);
        let rel = rel.to_owned();
        let seen = self.e.facts_until(|f| match f {
            Applied::Added { path, .. } | Applied::Changed { path, .. } => *path == rel,
            _ => false,
        });
        match seen.last() {
            Some(Applied::Added { note_id, .. } | Applied::Changed { note_id, .. }) => {
                note_id.clone()
            }
            other => panic!("{other:?}"),
        }
    }

    /// The file text runner's job for `source`: queued for `signature`, then finished with the
    /// text of each part unless `pending`.
    fn job(&self, source: TextSource, signature: &str, pages: Option<u32>, texts: &[(u32, &str)]) {
        let search = self.e.session.current().expect("open").search;
        search
            .reset_file_text(source.clone(), signature.into(), "1.0.0".into())
            .unwrap();
        if let Some(pages) = pages {
            search
                .set_file_text_page_count(source.clone(), pages)
                .unwrap();
        }
        for (part, text) in texts {
            search
                .save_extracted_part(
                    source.clone(),
                    *part,
                    ExtractedTextMethod::Ocr,
                    (*text).into(),
                )
                .unwrap();
        }
    }

    fn finish(&self, source: TextSource) {
        let search = self.e.session.current().expect("open").search;
        search
            .finish_file_text(source, JobOutcome::Done, None)
            .unwrap();
    }

    fn extracted(&self, note_id: &str) {
        let note_id = note_id.to_owned();
        feed::publish(
            &self.e.session,
            ProjectionEvent::NoteTextExtracted { note_id },
        );
    }

    /// Every lane event published so far, and every reconcile pass, has run.
    fn reconcile(&self) {
        let runtime = self.e.session.projections().expect("open");
        runtime.reconcile_named(&[image_projector::NAME]).unwrap();
        self.settled();
    }

    fn settled(&self) {
        let runtime = self.e.session.projections().expect("open");
        assert!(runtime.flush(WAIT));
        self.until("the reconcile passes", |_| runtime.live_threads() <= 1);
    }

    fn rows(&self) -> Vec<ImageEmbeddingState> {
        let search = self.e.session.current().expect("open").search;
        let mut rows = search.image_embedding_state(None).unwrap();
        rows.sort_by(|a, b| (&a.note_id, &a.source).cmp(&(&b.note_id, &b.source)));
        rows
    }

    fn keys(&self) -> Vec<String> {
        let rows = self.rows();
        rows.iter()
            .map(|row| format!("{}/{}", row.note_id, row.source))
            .collect()
    }

    fn vectors(&self) -> i64 {
        let search = self.e.session.current().expect("open").search;
        search
            .index_handle()
            .read_blocking(|conn| {
                Ok(conn
                    .query_row("SELECT COUNT(*) FROM vec_images", [], |row| row.get(0))
                    .unwrap())
            })
            .unwrap()
    }

    fn images(&self) -> Vec<ImageInput> {
        self.model.images.lock().unwrap().clone()
    }

    fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done(self) {
            assert!(Instant::now() < deadline, "still waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

const SHOT: &str = "Whiteboard sketch of the deploy pipeline";

#[test]
fn an_image_with_text_is_embedded_interleaved_at_the_page_budget() {
    let mut l = lane(Timing::default());
    let id = l.write("shot.png", "png bytes");
    l.job(of(&id, ""), "9:1", None, &[(1, SHOT)]);
    l.finish(of(&id, ""));
    l.extracted(&id);
    l.until("the vector", |l| l.rows().len() == 1);

    let row = &l.rows()[0];
    assert_eq!(row.source, "");
    assert_eq!(row.signature, format!("9:1|{}", SHOT.len()));
    assert_eq!(l.vectors(), 1);
    let images = l.images();
    assert_eq!(images.len(), 1);
    assert_eq!(images[0].bytes, b"png bytes");
    assert_eq!(
        images[0].soft_tokens,
        Some(image_projector::PAGE_SOFT_TOKENS)
    );
    let text = images[0].text.as_deref().expect("interleaved");
    assert!(text.contains(SHOT) && text.ends_with("<|image|>"), "{text}");
}

#[test]
fn a_photo_with_no_text_is_embedded_alone_and_svg_is_not() {
    let mut l = lane(Timing::default());
    let photo = l.write("cat.jpg", "jpeg bytes");
    let logo = l.write("logo.svg", "<svg/>");
    for id in [&photo, &logo] {
        l.job(of(id, ""), "1:1", None, &[]);
        l.finish(of(id, ""));
        l.extracted(id);
    }
    l.until("the vector", |l| !l.rows().is_empty());
    l.reconcile();
    assert_eq!(l.keys(), [format!("{photo}/")]);
    assert_eq!(l.rows()[0].signature, "1:1|0");
    let images = l.images();
    assert_eq!(images.len(), 1);
    assert_eq!(
        (images[0].text.as_deref(), images[0].soft_tokens),
        (None, None)
    );
}

#[test]
fn a_pdf_embeds_its_first_eight_pages_from_one_open() {
    let mut l = lane(Timing::default());
    let id = l.write("paper.pdf", "%PDF-1.4");
    l.job(of(&id, ""), "4:4", Some(12), &[(2, SHOT)]);
    l.finish(of(&id, ""));
    l.extracted(&id);
    l.until("eight vectors", |l| l.rows().len() == 8);

    let mut want: Vec<String> = (1..=8).map(|page| format!("{id}/#{page}")).collect();
    want.sort();
    assert_eq!(l.keys(), want);
    assert_eq!(
        l.pdf.opens.load(Ordering::SeqCst),
        1,
        "consecutive pages share the open"
    );
    let renders = l.pdf.renders.lock().unwrap().clone();
    assert_eq!(
        renders,
        (1..=8).map(|page| (page, 1400)).collect::<Vec<_>>()
    );
    let images = l.images();
    assert!(images.iter().all(|image| image.soft_tokens == Some(280)));
    assert!(images[1].text.as_deref().unwrap().contains(SHOT));
    assert_eq!(images[0].text, None);
}

#[test]
fn a_pending_job_waits_and_images_off_embed_nothing() {
    let mut l = lane(Timing::default());
    let id = l.write("shot.png", "png bytes");
    l.job(of(&id, ""), "9:1", None, &[]);
    l.extracted(&id);
    l.reconcile();
    assert!(l.rows().is_empty(), "OCR still pending");

    l.finish(of(&id, ""));
    l.on.store(false, Ordering::SeqCst);
    l.extracted(&id);
    l.reconcile();
    assert!(
        l.rows().is_empty() && l.images().is_empty(),
        "image embeddings off"
    );

    l.on.store(true, Ordering::SeqCst);
    l.reconcile();
    assert_eq!(l.keys(), [format!("{id}/")]);
}

#[test]
fn new_bytes_re_embed_and_the_same_bytes_do_not() {
    let mut l = lane(Timing::default());
    let id = l.write("shot.png", "png bytes");
    l.job(of(&id, ""), "9:1", None, &[]);
    l.finish(of(&id, ""));
    l.extracted(&id);
    l.until("the vector", |l| l.rows().len() == 1);
    l.extracted(&id);
    l.reconcile();
    assert_eq!(l.images().len(), 1, "nothing owed");

    l.job(of(&id, ""), "10:2", None, &[(1, SHOT)]);
    l.finish(of(&id, ""));
    l.extracted(&id);
    l.until("the new vector", |l| {
        l.rows()
            .first()
            .is_some_and(|row| row.signature.starts_with("10:2|"))
    });
    assert_eq!(l.images().len(), 2);
    assert_eq!(l.vectors(), 1);
}

#[test]
fn a_deleted_note_loses_its_vectors() {
    let mut l = lane(Timing::default());
    let id = l.write("paper.pdf", "%PDF-1.4");
    l.job(of(&id, ""), "4:4", Some(2), &[]);
    l.finish(of(&id, ""));
    l.extracted(&id);
    l.until("two vectors", |l| l.rows().len() == 2);

    let note_id = id.clone();
    feed::publish(
        &l.e.session,
        ProjectionEvent::NoteDeleted {
            note_id,
            path: None,
        },
    );
    l.until("no vectors", |l| l.rows().is_empty() && l.vectors() == 0);
}

/// Each failure reaches the model (no backoff between them), and the third in a row ends the
/// pass with two images still owed; the next pass embeds them once the model works.
#[test]
fn three_failures_in_a_row_end_the_pass() {
    let mut l = lane(Timing {
        retry_base: Duration::ZERO,
        ..Timing::default()
    });
    l.model.failing.store(true, Ordering::SeqCst);
    for name in ["a.png", "b.png", "c.png", "d.png", "e.png"] {
        let id = l.write(name, name);
        l.job(of(&id, ""), "1:1", None, &[]);
        l.finish(of(&id, ""));
    }
    l.reconcile();
    assert_eq!(l.images().len(), 3);
    assert!(l.rows().is_empty());

    l.model.failing.store(false, Ordering::SeqCst);
    l.reconcile();
    assert_eq!(l.rows().len(), 5);
}

/// A reconcile during the index build would read a half-filled `note_files` and drop the
/// vectors of every note not in it yet; it waits, and keeps them.
#[test]
fn the_reconcile_waits_for_the_index_build() {
    let mut l = lane(Timing::default());
    let id = l.write("shot.png", "png bytes");
    l.job(of(&id, ""), "9:1", None, &[]);
    l.finish(of(&id, ""));
    l.extracted(&id);
    l.until("the vector", |l| l.rows().len() == 1);

    l.e.core()
        .db_handle()
        .call_blocking(|conn| Ok(conn.execute("DELETE FROM note_files", []).unwrap()))
        .unwrap();
    l.indexing.store(true, Ordering::SeqCst);
    l.reconcile();
    assert_eq!(l.rows().len(), 1, "kept while indexing");
    l.indexing.store(false, Ordering::SeqCst);
    l.reconcile();
    assert!(l.rows().is_empty(), "the built index has no such note");
}
