//! Port of `packages/shared/src/youtube.ts`.

use url::Url;

/// `extractYouTubeVideoId`: the 11-character id of a YouTube watch, embed,
/// shorts or `youtu.be` URL, or `None`. The URL is parsed by the WHATWG
/// algorithm, as `new URL` does, so hostnames are lowercased, IDNA-mapped and
/// percent-decoded the same way.
pub fn extract_youtube_video_id(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let hostname = parsed.host_str().unwrap_or("").to_lowercase();
    if hostname == "youtu.be" {
        let first = parsed.path().split('/').find(|segment| !segment.is_empty());
        return valid_video_id(first);
    }
    if hostname != "youtube.com" && !hostname.ends_with(".youtube.com") {
        return None;
    }
    if parsed.path() == "/watch" {
        let v = parsed
            .query_pairs()
            .find(|(key, _)| key == "v")
            .map(|(_, value)| value.into_owned());
        return valid_video_id(v.as_deref());
    }
    let mut segments = parsed
        .path()
        .split('/')
        .filter(|segment| !segment.is_empty());
    let kind = segments.next();
    let video_id = segments.next();
    if matches!(kind, Some("embed" | "shorts")) {
        return valid_video_id(video_id);
    }
    None
}

/// The id check of `getValidVideoId`: 11 UTF-16 units, each `[0-9A-Za-z_-]`. A
/// non-ASCII character fails the class, so 11 valid characters is the same test.
fn valid_video_id(value: Option<&str>) -> Option<String> {
    let value = value?;
    let valid = value.chars().count() == 11
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    valid.then(|| value.to_owned())
}

/// `getYouTubeThumbnailUrl`: `hqdefault` exists for every video.
pub fn get_youtube_thumbnail_url(video_id: &str) -> String {
    format!("https://img.youtube.com/vi/{video_id}/hqdefault.jpg")
}
