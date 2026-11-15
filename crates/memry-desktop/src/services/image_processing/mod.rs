//! Thumbnails, inbox images and view images: Electron's image-processing utility process
//! (`apps/desktop/src/main/image-processing/`), in process on pure-Rust decoders
//! (`memry_media`). sharp ran out of process for the Node heap; these decoders are memory safe
//! and bounded, so a pool of blocking tasks replaces the worker. Thumbnails are generated per
//! device and never uploaded.

mod encode;
mod pool;
mod video;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use memry_media::DecodeError;

use self::pool::Pool;
use self::video::Ffmpeg;

/// `MAX_QUEUED_REQUESTS` (`bridge.ts:25`).
const QUEUE_CAP: usize = 256;
/// `REQUEST_TIMEOUT_MS` (`bridge.ts:16`).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// `MAX_IN_FLIGHT_REQUESTS` (`bridge.ts:23`), on no more threads than the machine has cores.
const MAX_WORKERS: usize = 4;

#[derive(Debug, thiserror::Error)]
pub enum ImageError {
    /// More requests wait than the queue holds.
    #[error("image processing is busy")]
    Busy,
    #[error("image processing request timed out")]
    TimedOut,
    #[error("image processing failed: {0}")]
    Failed(String),
    #[error(transparent)]
    Decode(#[from] DecodeError),
    #[error("cannot read the image: {0}")]
    Read(#[from] std::io::Error),
    #[error("cannot encode the image: {0}")]
    Encode(String),
}

/// A WebP thumbnail, its long edge at most 200 px.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thumbnail {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// `InboxImageProcessingPayload` (`protocol.ts`): sharp's metadata and a 400 px JPEG.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxImage {
    /// sharp's format name: `png`, `jpeg`, `gif` or `webp`.
    pub format: &'static str,
    /// The stored size, before the EXIF orientation.
    pub width: u32,
    pub height: u32,
    /// The image carries EXIF or a colour profile.
    pub has_exif: bool,
    pub thumbnail_jpeg: Option<Vec<u8>>,
}

/// `ViewImagePayload` (`protocol.ts`): an image an agent can look at, and the upright size of the
/// image it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewImage {
    pub data: Vec<u8>,
    /// `image/png` or `image/jpeg`.
    pub mime_type: &'static str,
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
}

pub struct ImageService {
    pool: Pool,
    ffmpeg: Arc<Ffmpeg>,
}

impl Default for ImageService {
    fn default() -> Self {
        Self::new()
    }
}

impl ImageService {
    /// Finds ffmpeg on this process's `PATH`.
    pub fn new() -> Self {
        let dirs = video::search_dirs(std::env::var_os("PATH").as_deref());
        Self::with_ffmpeg(Ffmpeg::new(dirs, video::RUN_TIMEOUT))
    }

    /// Looks for ffmpeg only in `dirs` and gives it `video_timeout`.
    #[cfg(feature = "test-hooks")]
    pub fn with_ffmpeg_dirs(dirs: Vec<PathBuf>, video_timeout: Duration) -> Self {
        Self::with_ffmpeg(Ffmpeg::new(dirs, video_timeout))
    }

    fn with_ffmpeg(ffmpeg: Ffmpeg) -> Self {
        let cores = std::thread::available_parallelism().map_or(1, usize::from);
        Self {
            pool: Pool::new(cores.min(MAX_WORKERS), QUEUE_CAP, REQUEST_TIMEOUT),
            ffmpeg: Arc::new(ffmpeg),
        }
    }

    /// `generateThumbnailInWorker` (`operations.ts:123-142`): an image, the PDF badge, or a video
    /// frame through ffmpeg, all as WebP. None for any other type, and when the file cannot be
    /// thumbnailed (logged), as Electron returns null.
    pub async fn generate_thumbnail(
        &self,
        path: PathBuf,
        mime_type: &str,
    ) -> Result<Option<Thumbnail>, ImageError> {
        let kind = match mime_type {
            "image/png" | "image/jpeg" | "image/gif" | "image/webp" => Kind::Image,
            "application/pdf" => {
                let (width, height) = encode::PDF_BADGE_SIZE;
                return Ok(Some(Thumbnail {
                    data: encode::PDF_BADGE.to_vec(),
                    width,
                    height,
                }));
            }
            "video/mp4" | "video/webm" => Kind::Video,
            _ => return Ok(None),
        };
        let ffmpeg = Arc::clone(&self.ffmpeg);
        self.pool
            .run(move || {
                let thumbnail = match kind {
                    Kind::Image => encode::read_bounded(&path)
                        .map_err(ImageError::from)
                        .and_then(|bytes| encode::thumbnail(&bytes)),
                    Kind::Video => match ffmpeg.frame_png(&path) {
                        Some(frame) => memry_media::decode_rgba(&frame)
                            .map_err(ImageError::from)
                            .and_then(|(_, image)| encode::webp(&image)),
                        None => return None,
                    },
                };
                thumbnail
                    .inspect_err(|error| tracing::warn!(%error, "thumbnail generation failed"))
                    .ok()
            })
            .await
    }

    /// `processInboxImageFile` (`operations.ts:40-74`).
    pub async fn inbox_image(&self, path: PathBuf) -> Result<InboxImage, ImageError> {
        self.pool
            .run(move || encode::inbox_image(&encode::read_bounded(&path)?))
            .await?
    }

    /// `prepareViewImage` (`operations.ts:76-121`). Takes bytes, never a path, as Electron's
    /// worker does: the caller reads the file it checked.
    pub async fn prepare_view_image(
        &self,
        bytes: Vec<u8>,
        max_edge: u32,
    ) -> Result<ViewImage, ImageError> {
        self.pool
            .run(move || encode::view_image(&bytes, max_edge))
            .await?
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Image,
    Video,
}
