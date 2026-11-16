//! The image embedding projector: the `image-embedding` lane, a port of Electron's
//! `apps/desktop/src/main/projections/projectors/image-embedding-projector.ts` over
//! [`EmbeddingService::embed_image`] and the core's image vector store
//! ([`image_embeddings`](memry_core::domain::image_embeddings)).
//!
//! Image vectors sit beside the text vectors in `vec_images`, keyed like the text extraction
//! job that found the file (a filed file, or one a note embeds), and are searchable by text
//! because both encoders share one space. An image with no text read from it is embedded
//! alone; an image with text (a screenshot, a scan) and each of a PDF's first eight pages is
//! embedded interleaved: the page image at 280 soft tokens plus its text in one vector (#3129).
//!
//! - **Owed lives in `index.db`.** An image is owed once its text job has settled, and again
//!   when its bytes or text change (the signature) or the input version moves. A failed embed
//!   stores nothing and is tried again on the next event or vault open; a pass gives up after
//!   three failures in a row (:21-24, 140-150).
//! - **Gated before every image**: the session's cancel token, the vault still being the one
//!   the work started on, and `ai.enabled` with `ai.imageEmbeddings` (`isImageEmbeddingEnabled`).
//!   The listing's drop of vectors whose image is gone runs whatever the setting (:120-126).
//! - **Departures.** The reconcile and rebuild wait while the index builds, as the note lane's
//!   do: `note_files` may be half filled, and the listing would drop the vectors of every note
//!   not yet in it. [`super::projector::drain_deferred`] runs the reconcile once it is done. A
//!   deleted note's vectors are dropped by its id: `index.db` has no cascade from `data.db`
//!   (Electron's state rows went with the note's `note_cache` row, :170-180). An image the
//!   worker cannot decode is [`EmbedError::Input`](super::service::EmbedError::Input) and counts
//!   toward no breaker, so one corrupt image never stops the rest of the backfill (Electron
//!   counts it). The rebuild refuses with images off before it clears the vectors.

use std::collections::{HashMap, HashSet};
use std::io::Read as _;
use std::path::Path;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::domain::embedding_input::{IMAGE_EMBEDDING_INPUT_VERSION, build_interleaved_input};
use memry_core::domain::image_embeddings::{ImageFile, ImageSource};

use super::projector::Indexing;
use super::service::{EmbeddingService, ImageInput};
use crate::services::file_text::{PdfPages, PdfReader};
use crate::session::projection::{CancelToken, ProjectionEvent, Projector, Rebuilt};
use crate::session::{OpenVault, Session};
use crate::shell::file_open::Resolution;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::paths::{open_vault_file, resolve_vault_file};

/// The lane's name (`embedding::PROJECTORS[1]`).
pub const NAME: &str = "image-embedding";
/// `MAX_IMAGE_BYTES`: larger files are skipped (they cross to the worker in one message).
const MAX_IMAGE_BYTES: u64 = 30 << 20;
/// `MAX_CONSECUTIVE_FAILURES`: failed embeds in a row that end a pass.
const MAX_CONSECUTIVE_FAILURES: u32 = 3;
/// `EMBEDDING_PAGE_RENDER_EDGE`: long edge of a PDF page handed to the encoder.
pub const PAGE_RENDER_EDGE: u32 = 1400;
/// `EMBEDDING_PAGE_SOFT_TOKENS`: the budget of a page or an image with text.
pub const PAGE_SOFT_TOKENS: u32 = 280;

/// Whether `ai.enabled` and `ai.imageEmbeddings` are on for the open vault
/// (`isImageEmbeddingEnabled`); `false` when they cannot be read.
pub type ImagesEnabled = Arc<dyn Fn(&OpenVault) -> bool + Send + Sync>;

/// What the encoder reads, from a file's name: raster images (not SVG, a text format it cannot
/// rasterize) and PDFs (`isEmbeddableImageName`, `attachmentType`).
pub fn classify(name: &str) -> Option<ImageFile> {
    let ext = extension(name);
    match file_type_of_extension(&ext)? {
        FileType::Pdf => Some(ImageFile::Pdf),
        FileType::Image if ext != "svg" => Some(ImageFile::Image),
        _ => None,
    }
}

pub struct ImageEmbeddingProjector {
    session: Session,
    service: Arc<EmbeddingService>,
    pdf: Arc<dyn PdfReader>,
    enabled: ImagesEnabled,
    indexing: Indexing,
}

struct Work<'a> {
    open: OpenVault,
    cancel: &'a CancelToken,
}

/// The PDF a pass is on; consecutive pages of one file share it.
type OpenDocument<'a> = Option<(String, Box<dyn PdfPages + 'a>)>;

fn text(error: StorageError) -> String {
    error.to_string()
}

fn close(document: &mut OpenDocument<'_>) {
    if let Some((_, pdf)) = document.take()
        && let Err(error) = pdf.close()
    {
        tracing::debug!(
            scope = "Projections:ImageEmbeddings",
            "closing a PDF failed: {error}"
        );
    }
}

/// `readImageBytes`: the file's bytes, `None` when it is missing, outside the vault or over
/// [`MAX_IMAGE_BYTES`] (read through the open file, at most one byte past the cap).
fn read_image(vault: &Path, rel: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(file) = open_vault_file(vault, rel).map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    (&file)
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok((bytes.len() as u64 <= MAX_IMAGE_BYTES).then_some(bytes))
}

impl ImageEmbeddingProjector {
    pub fn new(
        session: &Session,
        service: Arc<EmbeddingService>,
        pdf: Arc<dyn PdfReader>,
        enabled: ImagesEnabled,
        indexing: Indexing,
    ) -> Arc<Self> {
        Arc::new(Self {
            session: session.clone(),
            service,
            pdf,
            enabled,
            indexing,
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
            && (self.enabled)(&work.open)
    }

    /// `renderPdfPage`: the page as PNG, opening the file unless the pass is on it already;
    /// `None` when it is outside the vault, missing, or has fewer pages.
    fn render<'a>(
        &'a self,
        vault: &Path,
        image: &ImageSource,
        page: u32,
        document: &mut OpenDocument<'a>,
    ) -> Result<Option<Vec<u8>>, String> {
        if document
            .as_ref()
            .is_none_or(|(path, _)| *path != image.path)
        {
            close(document);
            let Resolution::Inside(path) =
                resolve_vault_file(vault, &image.path).map_err(|error| error.to_string())?
            else {
                return Ok(None);
            };
            *document = Some((image.path.clone(), self.pdf.open(&path)?));
        }
        let (_, pdf) = document.as_ref().expect("opened above");
        if page > pdf.page_count() {
            return Ok(None);
        }
        pdf.render_page(page, PAGE_RENDER_EDGE).map(Some)
    }

    /// `embedOne`: whether the image's vector was stored. A failure closes the open PDF.
    fn embed_one<'a>(
        &'a self,
        work: &Work<'_>,
        image: &ImageSource,
        document: &mut OpenDocument<'a>,
    ) -> bool {
        let vault = work.open.path.clone();
        let embedded = (|| {
            let bytes = match image.page {
                None => read_image(&vault, &image.path)?,
                Some(page) => self.render(&vault, image, page, document)?,
            };
            let Some(bytes) = bytes else {
                return Ok(false);
            };
            let interleaved = build_interleaved_input(Some(&image.text));
            // Pages and images with text are documents and get the page budget.
            let page_budget = interleaved.is_some() || image.page.is_some();
            let input = ImageInput {
                bytes,
                text: interleaved,
                soft_tokens: page_budget.then_some(PAGE_SOFT_TOKENS),
            };
            let Some(vector) = self.service.embed_image(input) else {
                return Ok(false);
            };
            if !self.may_embed(work) {
                return Ok(false);
            }
            work.open
                .search
                .store_image_embedding(image.clone(), vector)
                .map_err(text)?;
            Ok::<_, String>(true)
        })();
        match embedded {
            Ok(true) => true,
            Ok(false) => false,
            Err(error) => {
                close(document);
                tracing::warn!(
                    scope = "Projections:ImageEmbeddings",
                    note_id = image.note_id,
                    %error,
                    "Failed to embed image"
                );
                false
            }
        }
    }

    /// `sync`: make the vectors of `note_ids` (or of every note) match the images the index
    /// knows: drop the ones whose image is gone, then embed the missing and outdated ones,
    /// images with no vector first. The number stored.
    fn sync(&self, work: &Work<'_>, note_ids: Option<Vec<String>>) -> Result<u32, String> {
        let search = &work.open.search;
        let images = search
            .image_sources(note_ids.clone(), classify)
            .map_err(text)?;
        let state = search.image_embedding_state(note_ids).map_err(text)?;
        let known: HashSet<(&str, &str)> = images
            .iter()
            .map(|image| (image.note_id.as_str(), image.source.as_str()))
            .collect();
        let gone: Vec<(String, String)> = state
            .iter()
            .filter(|row| !known.contains(&(row.note_id.as_str(), row.source.as_str())))
            .map(|row| (row.note_id.clone(), row.source.clone()))
            .collect();
        if !gone.is_empty() {
            search.delete_image_embeddings(gone).map_err(text)?;
        }
        if !self.may_embed(work) {
            return Ok(0);
        }
        let stored: HashMap<(&str, &str), _> = state
            .iter()
            .map(|row| ((row.note_id.as_str(), row.source.as_str()), row))
            .collect();
        let row = |image: &ImageSource| {
            stored
                .get(&(image.note_id.as_str(), image.source.as_str()))
                .copied()
        };
        let owed = images.iter().filter(|image| {
            image.settled
                && row(image).is_none_or(|row| {
                    row.signature != image.signature
                        || row.input_version != IMAGE_EMBEDDING_INPUT_VERSION
                })
        });
        let (new, outdated): (Vec<_>, Vec<_>) = owed.partition(|image| row(image).is_none());
        let work_list: Vec<&ImageSource> = new.into_iter().chain(outdated).collect();

        let mut document: OpenDocument<'_> = None;
        let (mut failures, mut computed) = (0, 0);
        for (done, image) in work_list.iter().enumerate() {
            if !self.may_embed(work) {
                break;
            }
            if self.embed_one(work, image, &mut document) {
                failures = 0;
                computed += 1;
            } else {
                failures += 1;
            }
            if failures >= MAX_CONSECUTIVE_FAILURES {
                tracing::warn!(
                    scope = "Projections:ImageEmbeddings",
                    remaining = work_list.len() - done - 1,
                    "Image embedding paused after repeated failures"
                );
                break;
            }
        }
        close(&mut document);
        Ok(computed)
    }
}

impl Projector for ImageEmbeddingProjector {
    fn name(&self) -> &str {
        NAME
    }

    /// Vision inference takes seconds per image; nothing reads vectors back in the same turn.
    fn background(&self) -> bool {
        true
    }

    fn handles(&self, event: &ProjectionEvent) -> bool {
        matches!(
            event,
            ProjectionEvent::NoteDeleted { .. } | ProjectionEvent::NoteTextExtracted { .. }
        )
    }

    fn project(&self, event: &ProjectionEvent, cancel: &CancelToken) -> Result<(), String> {
        let Some(work) = self.work(cancel) else {
            return Ok(());
        };
        match event {
            ProjectionEvent::NoteDeleted { note_id, .. } => {
                let search = &work.open.search;
                let rows = search
                    .image_embedding_state(Some(vec![note_id.clone()]))
                    .map_err(text)?;
                let rows = rows.into_iter().map(|row| (row.note_id, row.source));
                search
                    .delete_image_embeddings(rows.collect())
                    .map_err(text)?;
                search.prune_image_embeddings().map_err(text)
            }
            ProjectionEvent::NoteTextExtracted { note_id } => {
                self.sync(&work, Some(vec![note_id.clone()])).map(drop)
            }
            _ => Ok(()),
        }
    }

    /// `rebuild`: every image vector dropped, then every image embedded again. Refused while
    /// the index builds, and with images off, where it would delete vectors it cannot restore
    /// (Electron clears first, then finds them off: a departure, Kaan 9 Nov).
    fn rebuild(&self, cancel: &CancelToken) -> Result<Rebuilt, String> {
        let Some(work) = self.work(cancel) else {
            return Err("Projector database is no longer current".into());
        };
        if (self.indexing)() {
            return Err("The index is building".into());
        }
        // Before the clear: a rebuild that cannot embed must not delete what is stored.
        if !(self.enabled)(&work.open) {
            return Err("image embeddings are off".into());
        }
        work.open.search.clear_image_embeddings().map_err(text)?;
        let computed = self.sync(&work, None)?;
        Ok(Rebuilt {
            computed,
            skipped: 0,
        })
    }

    /// `reconcile`: orphan vectors pruned, then every vault image synced. Left to
    /// [`super::projector::drain_deferred`] while the index builds.
    fn reconcile(&self, cancel: &CancelToken) -> Result<(), String> {
        let Some(work) = self.work(cancel) else {
            return Ok(());
        };
        if (self.indexing)() {
            return Ok(());
        }
        work.open.search.prune_image_embeddings().map_err(text)?;
        self.sync(&work, None).map(drop)
    }
}
