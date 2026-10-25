//! `isVideoUrl` of BlockNote's `util/string.ts`: the extension of
//! `new URL(url).pathname` against a fixed list, `false` when the URL does not
//! parse (a relative URL has no base to parse against).

use url::Url;

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "webm", "ogg", "mov", "mkv", "flv", "avi", "wmv", "m4v",
];

pub(super) fn is_video_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    let ext = parsed
        .path()
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase();
    VIDEO_EXTENSIONS.contains(&ext.as_str())
}
