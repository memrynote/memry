//! The site extractors of `dist/extractors/` and their registry
//! (`dist/extractor-registry.js`), ported in stages 5 and 6 of Step 26 (#3543).
//!
//! An extractor reads the page document, and either returns the content HTML itself or names a
//! `content_selector` for Defuddle's own pipeline to run on. The registration order below is
//! the JS order: the first mapping whose pattern matches and whose instance passes the
//! predicate wins. Some extractors change the page in their constructor (NYT and Substack
//! inject rendered content, Medium cleans the article in `extract`), so building an instance is
//! fallible and happens for every matching mapping, as in JS.

mod base;
mod bbcode_data;
mod bilibili;
mod bluesky;
mod c2_wiki;
mod chatgpt;
mod claude;
mod conversation;
mod discourse;
mod gemini;
mod github;
mod grok;
mod hackernews;
mod leetcode;
mod linkedin;
mod lwn;
mod mastodon;
mod medium;
mod nytimes;
mod reddit;
mod substack;
mod threads;
mod threads_json;
mod twitter;
mod wikipedia;
mod x_article;
mod x_oembed;
mod x_oembed_article;
mod youtube;
mod youtube_data;
mod youtube_group;
mod youtube_page;

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

pub use base::{Cx, Extracted, Extractor, Variables};

use super::error::ExtractError;

/// How a registered URL pattern matches: `domain.includes(pattern)` for a string, a regex test
/// on the whole URL for a regex.
enum Pattern {
    Domain(&'static str),
    Url(fn(&str) -> bool),
}

type Build = fn(&mut Cx) -> Result<Box<dyn Extractor>, ExtractError>;

/// One `register({ patterns, extractor })`: the patterns, the extractor's type name
/// (`constructor.name` without `Extractor`, lower-cased) and its constructor.
type Mapping = (Vec<Pattern>, &'static str, Build);

/// `/pattern/.test(url)` for a static regex. `\d` is written `[0-9]`: it is ASCII in JS.
macro_rules! re {
    ($pattern:literal) => {
        Pattern::Url(|url| {
            static RE: LazyLock<Regex> =
                LazyLock::new(|| Regex::new($pattern).expect("static pattern"));
            RE.is_match(url)
        })
    };
}

macro_rules! build {
    ($module:ident :: $ty:ident) => {
        |cx| Ok(Box::new($module::$ty::new(cx)?))
    };
}

/// `ExtractorRegistry.initialize()`, in registration order.
fn mappings() -> Vec<Mapping> {
    use Pattern::Domain as D;
    vec![
        (
            vec![D("x.com"), D("twitter.com")],
            "xarticle",
            build!(x_article::XArticleExtractor),
        ),
        (
            vec![D("twitter.com"), re!(r"/x\.com/.*")],
            "twitter",
            build!(twitter::TwitterExtractor),
        ),
        (
            vec![D("x.com"), D("twitter.com")],
            "xoembed",
            build!(x_oembed::XOembedExtractor),
        ),
        (
            vec![
                D("reddit.com"),
                D("old.reddit.com"),
                D("new.reddit.com"),
                re!(r"^https://[^/]+\.reddit\.com"),
            ],
            "reddit",
            build!(reddit::RedditExtractor),
        ),
        (
            vec![
                D("youtube.com"),
                D("youtu.be"),
                re!(r"youtube\.com/watch\?v=.*"),
                re!(r"youtu\.be/.*"),
            ],
            "youtube",
            build!(youtube::YoutubeExtractor),
        ),
        (
            vec![
                D("bilibili.com"),
                re!(r"www\.bilibili\.com/video/BV[0-9A-Za-z]+"),
            ],
            "bilibili",
            build!(bilibili::BilibiliExtractor),
        ),
        (
            vec![D("news.ycombinator.com")],
            "hackernews",
            build!(hackernews::HackerNewsExtractor),
        ),
        (
            vec![re!(r"^https?://chatgpt\.com/(c|share)/.*")],
            "chatgpt",
            build!(chatgpt::ChatGptExtractor),
        ),
        (
            vec![D("claude.ai"), re!(r"^https?://claude\.ai/(chat|share)/.*")],
            "claude",
            build!(claude::ClaudeExtractor),
        ),
        (
            vec![re!(r"^https?://grok\.com/(chat|share)(/.*)?$")],
            "grok",
            build!(grok::GrokExtractor),
        ),
        (
            vec![re!(r"^https?://gemini\.google\.com/app/.*")],
            "gemini",
            build!(gemini::GeminiExtractor),
        ),
        (
            vec![D("github.com"), re!(r"^https?://github\.com/.*")],
            "github",
            build!(github::GitHubExtractor),
        ),
        (
            vec![D("linkedin.com")],
            "linkedin",
            build!(linkedin::LinkedInExtractor),
        ),
        (
            vec![D("threads.net"), D("www.threads.com"), D("threads.com")],
            "threads",
            build!(threads::ThreadsExtractor),
        ),
        (
            vec![D("bsky.app")],
            "bluesky",
            build!(bluesky::BlueskyExtractor),
        ),
        (
            vec![D("medium.com"), re!(r"\.medium\.com")],
            "medium",
            build!(medium::MediumExtractor),
        ),
        (
            vec![D("wiki.c2.com")],
            "c2wiki",
            build!(c2_wiki::C2WikiExtractor),
        ),
        (
            vec![
                re!(r"^https?://substack\.com/@[^/]+/note/.+"),
                re!(r"^https?://substack\.com/home/post/p-[0-9]+"),
                D("substack.com"),
            ],
            "substack",
            build!(substack::SubstackExtractor),
        ),
        (
            vec![D("nytimes.com")],
            "nytimes",
            build!(nytimes::NytimesExtractor),
        ),
        (
            vec![D("wikipedia.org")],
            "wikipedia",
            build!(wikipedia::WikipediaExtractor),
        ),
        (
            vec![re!(r"/@[^/]+/[0-9]+")],
            "mastodon",
            build!(mastodon::MastodonExtractor),
        ),
        (
            vec![re!(r"/t/[^/]+/[0-9]+")],
            "discourse",
            build!(discourse::DiscourseExtractor),
        ),
        (
            vec![D("leetcode.com")],
            "leetcode",
            build!(leetcode::LeetCodeExtractor),
        ),
        (vec![D("lwn.net")], "lwn", build!(lwn::LwnExtractor)),
        (
            vec![re!(r".*")],
            "bbcodedata",
            build!(bbcode_data::BbcodeDataExtractor),
        ),
    ]
}

/// Which `canExtract*` predicate `findByPredicate` applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Find {
    /// `findExtractor`: `canExtract()`.
    Sync,
    /// `findAsyncExtractor`: `canExtractAsync()`.
    Async,
    /// `findPreferredAsyncExtractor`: `canExtractAsync() && prefersAsync()`.
    PreferredAsync,
}

static MAPPINGS: LazyLock<Vec<Mapping>> = LazyLock::new(mappings);

/// The type names of the registered extractors, in registration order.
pub fn extractor_names() -> Vec<&'static str> {
    MAPPINGS.iter().map(|(_, name, _)| *name).collect()
}

/// A registered extractor's type name and instance.
pub type Found = (&'static str, Box<dyn Extractor>);

/// `ExtractorRegistry.findByPredicate`: any error, from the URL parse to a constructor or a
/// predicate, ends the search with no extractor (JS logs it).
pub fn find_extractor(cx: &mut Cx, find: Find) -> Option<Found> {
    match search(cx, find) {
        Ok(found) => found,
        Err(error) => {
            tracing::error!(%error, "Error finding extractor");
            None
        }
    }
}

fn search(cx: &mut Cx, find: Find) -> Result<Option<Found>, ExtractError> {
    let url = cx.url.to_string();
    let parsed = Url::parse(&url).map_err(|e| ExtractError::Js(format!("Invalid URL: {e}")))?;
    let domain = parsed.host_str().unwrap_or_default().to_string();
    for (patterns, name, build) in MAPPINGS.iter() {
        let matches = patterns.iter().any(|pattern| match pattern {
            Pattern::Url(test) => test(&url),
            Pattern::Domain(p) => domain.contains(p),
        });
        if !matches {
            continue;
        }
        let mut instance = build(cx)?;
        let ok = match find {
            Find::Sync => instance.can_extract(cx)?,
            Find::Async => instance.can_extract_async(cx)?,
            Find::PreferredAsync => instance.can_extract_async(cx)? && instance.prefers_async(),
        };
        if ok {
            return Ok(Some((name, instance)));
        }
    }
    Ok(None)
}
