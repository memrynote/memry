//! Which URLs the shell hands to the OS: port of `isAllowedExternalUrl`
//! (`apps/desktop/src/main/lib/external-url.ts`). Only web and mail schemes, so a link in a note
//! cannot launch `file:`, `smb:` or a custom protocol handler through the OS.

use url::Url;

/// A URL longer than this is not a link a person clicked.
const MAX_URL_LEN: usize = 16 * 1024;

pub fn is_allowed_external_url(raw: &str) -> bool {
    raw.len() <= MAX_URL_LEN
        && Url::parse(raw).is_ok_and(|url| matches!(url.scheme(), "https" | "http" | "mailto"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_web_and_mail() {
        assert!(is_allowed_external_url("https://example.com"));
        assert!(is_allowed_external_url("http://example.com"));
        assert!(is_allowed_external_url("mailto:hi@memrynote.com"));
        assert!(is_allowed_external_url("HTTPS://EXAMPLE.COM/a?b=c#d"));
    }

    #[test]
    fn blocks_everything_else() {
        for url in [
            "file:///etc/passwd",
            "smb://host/share",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "memry-file://local/Users/kaan/vault/file.png",
            "vscode://open",
            "",
            "not a url",
            "//example.com",
        ] {
            assert!(!is_allowed_external_url(url), "{url}");
        }
    }

    #[test]
    fn refuses_an_oversize_url() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert!(!is_allowed_external_url(&long));
    }
}
