//! `images.ts`: the name a Readwise image is stored under, so it can be found again, and the
//! download that stores it.

use sha2::{Digest, Sha256};

use super::library::Library;
use super::types::SavedImages;
use crate::attachments::{self, relative_ref};
use crate::vault::layout::ATTACHMENTS_DIR;

const SCOPE: &str = "ReadwiseImages";

/// `imageFileStem`: `rw-` and the first 16 hex digits of the SHA-256 of the URL's UTF-8 bytes.
pub fn image_file_stem(url: &str) -> String {
    let digest = hex::encode(Sha256::digest(url.as_bytes()));
    format!("rw-{}", &digest[..16])
}

/// `resolveImages`: saves each remote image as an attachment of the note named
/// `rw-<hash>.<ext>` (D14), reusing a file already there, so an unchanged book downloads
/// nothing and a takeover finds the files that synced with the notes. Only `http(s)` URLs are
/// fetched, at most `MAX_REMOTE_BYTES` each. A failed download leaves the URL out of the map
/// and the planners leave it out of the note.
pub(crate) fn resolve_images(
    library: &Library,
    note_id: &str,
    note_path: &str,
    urls: &[String],
) -> SavedImages {
    let mut resolved = SavedImages::new();
    if urls.is_empty() {
        return resolved;
    }
    let existing = attachments::list(&library.open, note_id).unwrap_or_else(|error| {
        tracing::warn!(
            scope = SCOPE,
            note_id,
            "the note's attachments could not be listed: {error}"
        );
        Vec::new()
    });
    for url in urls {
        let stem = image_file_stem(url);
        let prefix = format!("{stem}.");
        if let Some(present) = existing
            .iter()
            .find(|file| file.filename.starts_with(&prefix))
        {
            let target = format!("{ATTACHMENTS_DIR}/{note_id}/{}", present.filename);
            resolved.insert(url.clone(), relative_ref(note_path, &target));
            continue;
        }
        let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
        if !lower.starts_with("http://") && !lower.starts_with("https://") {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "skipping a Readwise image that is not an http(s) URL"
            );
            continue;
        }
        match save_image(library, note_id, url, &stem) {
            Ok(path) => {
                resolved.insert(url.clone(), path);
            }
            Err(reason) => tracing::warn!(
                scope = SCOPE,
                note_id,
                "a Readwise image could not be saved; it stays out of the note: {reason}"
            ),
        }
    }
    resolved
}

fn save_image(library: &Library, note_id: &str, url: &str, stem: &str) -> Result<String, String> {
    let fetched = library
        .runtime
        .block_on(library.images.fetch(url))
        .map_err(|failure| format!("{failure:?}"))?;
    let name = format!("{stem}.{}", attachments::extension(&fetched.filename));
    let note_path = attachments::writable_note(&library.open, note_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the note has no file".to_owned())?;
    let saved = attachments::save_exact(
        &library.open.path,
        note_id,
        Some(&note_path),
        &name,
        &fetched.bytes,
    )
    .map_err(|error| error.to_string())?;
    Ok(saved.path)
}
