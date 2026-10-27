//! The `memry://` URL table (`handleDeepLink` in `apps/desktop/src/main/index.ts`, plus
//! `parseInboxOpenItemId`). Pure: the shell routes what this returns. A URL comes from outside
//! the app (a browser, the extension, the checkout page), so the parser bounds its input and
//! never reports the URL itself, only its coarse [`DeepLink::target`].

use url::Url;

/// Longer URLs are not ours: a clipper or checkout link is a few hundred bytes.
pub const MAX_URL_LEN: usize = 8192;

/// Links the renderer resolves itself (`lib/memry-links.ts`): the shell only brings the window
/// forward.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InContent {
    Note,
    Task,
    Canvas,
    CalendarEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    /// `memry://open[?item=<id>]`: launch or focus, and open an inbox item.
    Open {
        item_id: Option<String>,
    },
    BillingStart,
    BillingComplete {
        transaction_id: Option<String>,
    },
    Billing,
    /// Dead in Electron (nothing registers an OAuth state): the shell focuses and logs.
    OAuth {
        code: Option<String>,
        state: Option<String>,
    },
    Pair,
    InContent(InContent),
    Unknown,
}

impl DeepLink {
    /// The telemetry dimension: a coarse kind, never the URL.
    pub fn target(&self) -> &'static str {
        match self {
            Self::Open { .. } => "open",
            Self::BillingStart => "billing_start",
            Self::BillingComplete { .. } => "billing_complete",
            Self::Billing => "billing",
            Self::OAuth { .. } => "oauth",
            Self::Pair => "pair",
            Self::InContent(InContent::Note) => "note",
            Self::InContent(InContent::Task) => "task",
            Self::InContent(InContent::Canvas) => "canvas",
            Self::InContent(InContent::CalendarEvent) => "calendar_event",
            Self::Unknown => "unknown",
        }
    }
}

fn query(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// Parses `raw`. `None` when it is not a `memry:` URL at all (ignored, as Electron does); a
/// `memry:` URL with an unrecognised shape is [`DeepLink::Unknown`].
pub fn parse(raw: &str) -> Option<DeepLink> {
    if raw.len() > MAX_URL_LEN {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "memry" {
        return None;
    }
    let host = url.host_str().unwrap_or("");
    let path = url.path();
    Some(match host {
        "open" => DeepLink::Open {
            item_id: query(&url, "item"),
        },
        "billing" => match path {
            "/start" => DeepLink::BillingStart,
            "/complete" => DeepLink::BillingComplete {
                transaction_id: query(&url, "transactionId"),
            },
            _ => DeepLink::Billing,
        },
        "pair" => DeepLink::Pair,
        "oauth" => oauth(&url),
        _ if path.starts_with("/oauth") => oauth(&url),
        "note" if has_id(path) => DeepLink::InContent(InContent::Note),
        "task" if has_id(path) => DeepLink::InContent(InContent::Task),
        "canvas" if has_id(path) => DeepLink::InContent(InContent::Canvas),
        "calendar"
            if path
                .strip_prefix("/event/")
                .is_some_and(|id| !id.is_empty()) =>
        {
            DeepLink::InContent(InContent::CalendarEvent)
        }
        _ => DeepLink::Unknown,
    })
}

fn oauth(url: &Url) -> DeepLink {
    DeepLink::OAuth {
        code: query(url, "code"),
        state: query(url, "state"),
    }
}

fn has_id(path: &str) -> bool {
    path.strip_prefix('/').is_some_and(|id| !id.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(raw: &str) -> Option<&'static str> {
        parse(raw).map(|link| link.target())
    }

    #[test]
    fn every_route_has_its_target() {
        let table = [
            ("memry://open", "open"),
            ("memry://open?item=abc", "open"),
            ("memry://billing/start", "billing_start"),
            (
                "memry://billing/complete?transactionId=txn_1",
                "billing_complete",
            ),
            ("memry://billing/other", "billing"),
            ("memry://billing", "billing"),
            ("memry://oauth?code=c&state=s", "oauth"),
            ("memry://auth/oauth/callback?code=c", "oauth"),
            ("memry://pair", "pair"),
            ("memry://note/n1", "note"),
            ("memry://task/t1", "task"),
            ("memry://canvas/c1", "canvas"),
            ("memry://calendar/event/e1", "calendar_event"),
            ("memry://nope", "unknown"),
            ("memry://", "unknown"),
        ];
        for (url, expected) in table {
            assert_eq!(target(url), Some(expected), "{url}");
        }
    }

    #[test]
    fn a_calendar_event_link_with_a_date_is_an_in_content_link_not_unknown() {
        assert_eq!(
            parse("memry://calendar/event/abc%20d?date=2026-01-02"),
            Some(DeepLink::InContent(InContent::CalendarEvent))
        );
    }

    #[test]
    fn an_in_content_link_without_an_id_is_unknown() {
        assert_eq!(target("memry://note"), Some("unknown"));
        assert_eq!(target("memry://note/"), Some("unknown"));
        assert_eq!(target("memry://calendar/event/"), Some("unknown"));
        assert_eq!(target("memry://calendar/other/1"), Some("unknown"));
    }

    #[test]
    fn other_schemes_and_garbage_are_ignored() {
        for url in [
            "https://open",
            "file:///etc/passwd",
            "memry",
            "",
            "not a url",
        ] {
            assert_eq!(parse(url), None, "{url}");
        }
    }

    #[test]
    fn open_carries_the_inbox_item_id() {
        assert_eq!(
            parse("memry://open?item=a%20b"),
            Some(DeepLink::Open {
                item_id: Some("a b".to_owned())
            })
        );
        assert_eq!(
            parse("memry://open?other=1"),
            Some(DeepLink::Open { item_id: None })
        );
    }

    #[test]
    fn billing_complete_carries_the_transaction_id() {
        assert_eq!(
            parse("memry://billing/complete?transactionId=txn_9"),
            Some(DeepLink::BillingComplete {
                transaction_id: Some("txn_9".to_owned())
            })
        );
    }

    #[test]
    fn an_oversized_url_is_not_parsed() {
        let url = format!("memry://open?item={}", "a".repeat(MAX_URL_LEN));
        assert_eq!(parse(&url), None);
        let edge = format!("memry://open?item={}", "a".repeat(MAX_URL_LEN - 18));
        assert!(parse(&edge).is_some());
    }

    #[test]
    fn hostile_shapes_never_panic_and_stay_bounded() {
        // A fixed-seed generator: the same inputs on every run.
        let mut state = 0x9E37_79B9_7F4A_7C15_u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let alphabet = b"memry:/?&=%#.@[]\\ aZ09\0\xff";
        for _ in 0..5000 {
            let len = (next() % 64) as usize;
            let bytes: Vec<u8> = (0..len)
                .map(|_| alphabet[(next() % alphabet.len() as u64) as usize])
                .collect();
            let text = format!("memry://{}", String::from_utf8_lossy(&bytes));
            let _ = parse(&text);
        }
        let deep = format!("memry://note/{}", "/..".repeat(100_000 / 3));
        assert_eq!(parse(&deep), None);
        let nested = format!("memry://open?item={}", "%25".repeat(2000));
        let _ = parse(&nested);
    }
}
