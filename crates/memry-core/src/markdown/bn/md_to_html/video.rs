//! `isVideoUrl` of BlockNote's `util/string.ts`: `new URL(url).pathname`'s
//! extension against a fixed list, `false` when the URL does not parse.

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "webm", "ogg", "mov", "mkv", "flv", "avi", "wmv", "m4v",
];

fn is_slash(c: char, special: bool) -> bool {
    c == '/' || (special && c == '\\')
}

/// The URL host (after `userinfo@`) must be non-empty, free of forbidden code
/// points and carry a numeric port at most 65535.
fn authority_ok(authority: &str, allow_empty_host: bool) -> bool {
    let hostport = authority.rsplit('@').next().unwrap_or("");
    let (host, port) = if hostport.starts_with('[') {
        match hostport.find(']') {
            Some(e) => (&hostport[..=e], hostport[e + 1..].strip_prefix(':')),
            None => return false,
        }
    } else {
        match hostport.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (hostport, None),
        }
    };
    if let Some(p) = port
        && !(p.chars().all(|c| c.is_ascii_digit())
            && (p.is_empty() || p.parse::<u32>().is_ok_and(|n| n <= 65535)))
    {
        return false;
    }
    if host.is_empty() {
        return allow_empty_host;
    }
    if host.starts_with('[') {
        return true;
    }
    !host.chars().any(|c| {
        c <= ' '
            || c == '\u{7f}'
            || matches!(
                c,
                '#' | '/' | ':' | '<' | '>' | '?' | '@' | '[' | '\\' | ']' | '^' | '|'
            )
    })
}

pub(super) fn is_video_url(url: &str) -> bool {
    let s: String = url
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let Some(colon) = s.find(':') else {
        return false;
    };
    let scheme = &s[..colon];
    let mut sc = scheme.chars();
    if !sc.next().is_some_and(|c| c.is_ascii_alphabetic())
        || !sc.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return false;
    }
    let scheme = scheme.to_ascii_lowercase();
    let rest = &s[colon + 1..];
    let special = matches!(
        scheme.as_str(),
        "http" | "https" | "ftp" | "ws" | "wss" | "file"
    );
    let path: &str = if scheme == "file" {
        let mut it = rest.chars();
        if it.next().is_some_and(|c| is_slash(c, true))
            && it.next().is_some_and(|c| is_slash(c, true))
        {
            let after = &rest[2..];
            let end = after.find(['/', '\\', '?', '#']).unwrap_or(after.len());
            if !authority_ok(&after[..end], true) {
                return false;
            }
            &after[end..]
        } else {
            rest
        }
    } else if special {
        let after = rest.trim_start_matches(|c| is_slash(c, true));
        let end = after.find(['/', '\\', '?', '#']).unwrap_or(after.len());
        if !authority_ok(&after[..end], false) {
            return false;
        }
        &after[end..]
    } else if let Some(after) = rest.strip_prefix("//") {
        let end = after.find(['/', '?', '#']).unwrap_or(after.len());
        &after[end..]
    } else {
        rest
    };
    let pathname = &path[..path.find(['?', '#']).unwrap_or(path.len())];
    let ext = pathname.rsplit('.').next().unwrap_or("").to_lowercase();
    VIDEO_EXTENSIONS.contains(&ext.as_str())
}
