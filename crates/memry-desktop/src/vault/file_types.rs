//! Which files a vault holds (`packages/shared/src/file-types.ts`). Pinned to the TypeScript
//! by `tests/fixtures/file-types.json`.

use super::layout::{CANVAS_DIR, CANVAS_FILE_EXT};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileType {
    Markdown,
    Pdf,
    Image,
    Audio,
    Video,
}

impl FileType {
    /// The value stored in `note_files.file_type`.
    pub fn as_str(self) -> &'static str {
        match self {
            FileType::Markdown => "markdown",
            FileType::Pdf => "pdf",
            FileType::Image => "image",
            FileType::Audio => "audio",
            FileType::Video => "video",
        }
    }
}

/// (extension, type, MIME type)
pub(crate) const TABLE: &[(&str, FileType, &str)] = &[
    ("md", FileType::Markdown, "text/markdown"),
    ("pdf", FileType::Pdf, "application/pdf"),
    ("png", FileType::Image, "image/png"),
    ("jpg", FileType::Image, "image/jpeg"),
    ("jpeg", FileType::Image, "image/jpeg"),
    ("gif", FileType::Image, "image/gif"),
    ("webp", FileType::Image, "image/webp"),
    ("svg", FileType::Image, "image/svg+xml"),
    ("mp3", FileType::Audio, "audio/mpeg"),
    ("wav", FileType::Audio, "audio/wav"),
    ("ogg", FileType::Audio, "audio/ogg"),
    ("m4a", FileType::Audio, "audio/mp4"),
    ("flac", FileType::Audio, "audio/flac"),
    ("aac", FileType::Audio, "audio/aac"),
    ("mp4", FileType::Video, "video/mp4"),
    ("webm", FileType::Video, "video/webm"),
    ("mov", FileType::Video, "video/quicktime"),
    ("avi", FileType::Video, "video/x-msvideo"),
    ("mkv", FileType::Video, "video/x-matroska"),
];

/// `getExtension`: the text after the last dot of the whole string, lowercased; empty when
/// there is no dot or it is the last character.
pub fn extension(path: &str) -> String {
    match path.rfind('.') {
        Some(dot) if dot + 1 < path.len() => path[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

fn entry(ext: &str) -> Option<&'static (&'static str, FileType, &'static str)> {
    let ext = ext.to_lowercase();
    let ext = ext.strip_prefix('.').unwrap_or(&ext);
    TABLE.iter().find(|(e, _, _)| *e == ext)
}

pub fn file_type_of_extension(ext: &str) -> Option<FileType> {
    entry(ext).map(|(_, t, _)| *t)
}

pub fn mime_of_extension(ext: &str) -> Option<&'static str> {
    entry(ext).map(|(_, _, m)| *m)
}

/// `isSupportedPath`.
pub fn is_supported_path(path: &str) -> bool {
    let ext = extension(path);
    !ext.is_empty() && entry(&ext).is_some()
}

/// `isCanvasFilePath`, for a vault-relative path with `/` separators.
pub fn is_canvas_file_path(rel: &str) -> bool {
    rel.strip_prefix(CANVAS_DIR)
        .is_some_and(|rest| rest.starts_with('/'))
        && rel.to_lowercase().ends_with(CANVAS_FILE_EXT)
}
