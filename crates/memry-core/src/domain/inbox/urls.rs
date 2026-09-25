//! The URL helpers the inbox's capture path needs, as desktop writes them
//! (`apps/desktop/src/main/lib/url-utils.ts`, `inbox/metadata-utils.ts`).
//!
//! No URL crate: these read `scheme://host/path` the way WHATWG `URL` does for
//! the shapes a capture carries, and answer `None` where `new URL` throws.

/// `{hostname, pathname}` of an absolute `http(s)` URL.
struct Parts<'a> {
    host: String,
    path: &'a str,
}

fn parts(url: &str) -> Option<Parts<'_>> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host_port
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let after = &rest[end..];
    let path_end = after.find(['?', '#']).unwrap_or(after.len());
    let path = &after[..path_end];
    Some(Parts {
        host,
        path: if path.is_empty() { "/" } else { path },
    })
}

/// `extractDomain`: the hostname without a leading `www.`.
pub fn domain(url: &str) -> Option<String> {
    parts(url).map(|p| {
        p.host
            .strip_prefix("www.")
            .map_or(p.host.clone(), str::to_owned)
    })
}

/// Whether a string is an absolute URL a link capture accepts.
pub fn is_url(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.contains(char::is_whitespace)
        && (trimmed.starts_with("http://") || trimmed.starts_with("https://"))
        && parts(trimmed).is_some()
}

/// `detectSocialPlatform` + `isSocialPost`: a `twitter.com`/`x.com` status URL.
pub fn is_social_post(url: &str) -> bool {
    let Some(p) = parts(url) else {
        return false;
    };
    let host = p.host.strip_prefix("www.").unwrap_or(&p.host);
    if host != "twitter.com" && host != "x.com" {
        return false;
    }
    let segments: Vec<&str> = p.path.split('/').filter(|s| !s.is_empty()).collect();
    segments.windows(3).any(|w| {
        w[1].eq_ignore_ascii_case("status")
            && !w[2].is_empty()
            && w[2].chars().all(|c| c.is_ascii_digit())
    })
}

/// `extractSocialPost`'s handle: `@` + the first path segment.
pub fn social_handle(url: &str) -> String {
    parts(url)
        .and_then(|p| {
            p.path
                .split('/')
                .find(|s| !s.is_empty())
                .map(|s| format!("@{s}"))
        })
        .unwrap_or_default()
}

/// `extractTweetId`: the digits after `/status/`.
pub fn tweet_id(url: &str) -> Option<String> {
    let index = url.find("/status/")?;
    let digits: String = url[index + 8..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    (!digits.is_empty()).then_some(digits)
}

/// `titleFromUrl`: the last path segment made readable, else the host.
pub fn title_from_url(url: &str) -> String {
    let Some(p) = parts(url) else {
        return url.to_owned();
    };
    let host = p
        .host
        .strip_prefix("www.")
        .map_or(p.host.clone(), str::to_owned);
    let Some(last) = p.path.split('/').rfind(|s| !s.is_empty()) else {
        return host;
    };
    let mut cleaned = last.to_owned();
    // `.replace(/\.[a-z]+$/, '')`
    if let Some(dot) = cleaned.rfind('.') {
        let ext = &cleaned[dot + 1..];
        if !ext.is_empty() && ext.chars().all(|c| c.is_ascii_lowercase()) {
            cleaned.truncate(dot);
        }
    }
    // `--\d+$` then `-\d+$`
    for sep in ["--", "-"] {
        if let Some(index) = cleaned.rfind(sep) {
            let tail = &cleaned[index + sep.len()..];
            if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
                cleaned.truncate(index);
            }
        }
    }
    let spaced: String = cleaned
        .split(['-', '_'])
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = spaced.trim();
    if trimmed.is_empty() {
        return host;
    }
    // `.replace(/\b\w/g, c => c.toUpperCase())`: the first letter of each word.
    let mut out = String::with_capacity(trimmed.len());
    let mut boundary = true;
    for c in trimmed.chars() {
        let word = c.is_ascii_alphanumeric() || c == '_';
        if word && boundary {
            out.extend(c.to_uppercase());
        } else {
            out.push(c);
        }
        boundary = !word;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_follow_title_from_url() {
        assert_eq!(title_from_url("https://www.example.com/"), "example.com");
        assert_eq!(
            title_from_url("https://example.com/agent/how-we-build"),
            "How We Build"
        );
        assert_eq!(title_from_url("https://example.com/post-123"), "Post");
        assert_eq!(title_from_url("https://example.com/a/report.pdf"), "Report");
        assert_eq!(title_from_url("not a url"), "not a url");
    }

    #[test]
    fn social_posts_are_status_urls_on_x_and_twitter() {
        assert!(is_social_post("https://x.com/karpathy/status/12345"));
        assert!(is_social_post("https://twitter.com/a/status/9?s=20"));
        assert!(!is_social_post("https://x.com/karpathy"));
        assert!(!is_social_post("https://example.com/a/status/1"));
        assert_eq!(
            social_handle("https://x.com/karpathy/status/1"),
            "@karpathy"
        );
        assert_eq!(
            tweet_id("https://x.com/k/status/42?x=1").as_deref(),
            Some("42")
        );
        assert_eq!(
            domain("https://www.Linear.app/blog").as_deref(),
            Some("linear.app")
        );
    }
}
