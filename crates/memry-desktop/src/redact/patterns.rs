//! The patterns of `redact.ts`. `WS` is the JS `\s` set; `(?-u:\b)` is the JS ASCII `\b`.

use std::sync::LazyLock;

use regex::Regex;

const WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

fn compile(pattern: String) -> Regex {
    Regex::new(&pattern).unwrap_or_else(|error| panic!("redaction pattern `{pattern}`: {error}"))
}

macro_rules! lazy {
    ($build:expr) => {
        LazyLock::new(|| compile(($build)()))
    };
}

pub static JWT: LazyLock<Regex> =
    lazy!(|| { r"(?-u:\b)eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}".to_owned() });
pub static BEARER: LazyLock<Regex> =
    lazy!(|| format!(r"(?i)(?-u:\b)Bearer[{WS}]+[A-Za-z0-9._~+/=-]+"));
pub static AUTH_ASSIGN: LazyLock<Regex> = lazy!(|| {
    format!(
        r"(?i)(?-u:\b)[A-Za-z0-9_-]*(?:secret|password|passwd|token|api[_-]?key|apikey|authorization)(?-u:\b)[{WS}]*[:=][{WS}]*[^{WS}]+"
    )
});
pub static API_KEY: LazyLock<Regex> = lazy!(|| {
    r"(?-u:\b)(?:sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{8,}(?-u:\b)".to_owned()
});
pub static QUERY_SECRET: LazyLock<Regex> = lazy!(|| {
    format!(
        r"(?i)([?&](?:token|key|secret|access_token|refresh_token|sig|signature|password|auth)=)[^&{WS}]+"
    )
});
pub static LONG_SECRET: LazyLock<Regex> =
    lazy!(|| r"(?-u:\b)[A-Za-z0-9+/=_-]{40,}(?-u:\b)".to_owned());
pub static URL_QUERY: LazyLock<Regex> =
    lazy!(|| format!(r"(?i)((?-u:\b)https?://[^{WS}?#]+)[?#][^{WS}]*"));
pub static EMAIL: LazyLock<Regex> =
    lazy!(|| { r"(?-u:\b)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?-u:\b)".to_owned() });
pub static IPV4: LazyLock<Regex> = lazy!(|| {
    r"(?-u:\b)(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(?-u:\b)"
        .to_owned()
});
pub static IPV6: LazyLock<Regex> = lazy!(|| {
    r"(?-u:\b)(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?-u:\b)|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{0,4}"
        .to_owned()
});
pub static UUID: LazyLock<Regex> = lazy!(|| {
    r"(?i)(?-u:\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?-u:\b)".to_owned()
});
/// `/root` is matched here and its trailing boundary is checked in code.
pub static HOME_UNIX: LazyLock<Regex> =
    lazy!(|| format!(r#"(?:/Users/|/home/)[^/{WS}:)'"]+|/root"#));
pub static HOME_WIN: LazyLock<Regex> = lazy!(|| format!(r#"(?i)[A-Za-z]:\\Users\\[^\\{WS}:)'"]+"#));
pub static CONTENT_FILE: LazyLock<Regex> = lazy!(|| {
    r"(?i)([\p{L}\p{N}][\p{L}\p{N} ()._-]*)\.(md|markdown|pdf|txt|rtf|docx?|xlsx?|pptx?|csv|html?|json|png|jpe?g|gif|webp|svg|heic|tiff?|mp[34]|m4a|mov|zip)(?-u:\b)"
        .to_owned()
});
/// `UUID_SHAPED_VALUE` of `telemetry-api.ts`: no word boundaries.
pub static UUID_SHAPED: LazyLock<Regex> =
    lazy!(|| { r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}".to_owned() });

/// The coarser patterns of `redactSensitive`.
pub mod sensitive {
    use super::*;

    pub static JWT: LazyLock<Regex> = lazy!(|| {
        r"(?-u:\b)eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}".to_owned()
    });
    pub static BEARER: LazyLock<Regex> =
        lazy!(|| format!(r"(?i)Bearer[{WS}]+[A-Za-z0-9._~+/-]+=*"));
    pub static EMAIL: LazyLock<Regex> =
        lazy!(|| { r"(?-u:\b)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?-u:\b)".to_owned() });
    pub static UUID: LazyLock<Regex> = lazy!(|| {
        r"(?i)(?-u:\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?-u:\b)"
            .to_owned()
    });
    /// `/root/` needs its slash here, so no lookahead is involved.
    pub static HOME_UNIX: LazyLock<Regex> =
        lazy!(|| format!(r#"(?:/Users/|/home/|/root/)[^/{WS}:)'"]+"#));
    pub static HOME_WIN: LazyLock<Regex> =
        lazy!(|| format!(r#"(?i)[A-Za-z]:\\Users\\[^\\{WS}:)'"]+"#));
}
