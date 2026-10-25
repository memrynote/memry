//! Selector tables of `dist/constants.js`. Every list keeps the JS order because order decides
//! which rule fires first; the vectors compare each one element by element.

use std::sync::LazyLock;

/// Elements tried, in order, as the main content (`ENTRY_POINT_ELEMENTS`). `body` always matches.
pub const ENTRY_POINT_ELEMENTS: &[&str] = &[
    "#post",
    ".post-content",
    ".post-body",
    ".article-content",
    "#article-content",
    ".js-article-content",
    ".article_post",
    ".article-wrapper",
    ".entry-content",
    ".content-article",
    ".instapaper_body",
    ".post",
    ".markdown-body",
    "article",
    r#"[role="article"]"#,
    "main",
    r#"[role="main"]"#,
    ".article-body",
    "#content",
    "body", // ensures there is always a match
];

/// `CONTENT_ELEMENT_SELECTOR`: elements whose presence marks real article content. Joined with
/// `", "`.
pub const CONTENT_ELEMENT_SELECTORS: &[&str] = &[
    "math",
    "[data-mathml]",
    ".katex",
    ".katex-mathml",
    ".katex-display",
    ".MathJax",
    ".MathJax_Display",
    ".MathJax_SVG",
    "mjx-container",
    "pre",
    "code",
    "table",
    "img",
    "picture",
    "video",
    "blockquote",
    "figure",
];

pub static CONTENT_ELEMENT_SELECTOR: LazyLock<String> =
    LazyLock::new(|| CONTENT_ELEMENT_SELECTORS.join(", "));

/// `HIDDEN_EXACT_SKIP_SELECTORS`: the hidden-element selectors as the hidden pass tests them.
pub const HIDDEN_EXACT_SKIP_SELECTORS: &[&str] = &[
    "[hidden]",
    r#"[aria-hidden="true"]"#,
    ".hidden",
    ".invisible",
];

/// `HIDDEN_EXACT_SELECTORS`. Paywall sites (e.g. Future PLC) mark gated paragraphs with
/// aria-hidden="true" + class="paywall"; those are preserved so the article text is not stripped,
/// which would trigger a low-word-count retry with partial selectors disabled.
pub const HIDDEN_EXACT_SELECTORS: &[&str] = &[
    "[hidden]",
    r#"[aria-hidden="true"]:not([class*="math"]):not(svg):not([class*="paywall"])"#,
    ".hidden",
    ".invisible",
];

pub static HIDDEN_EXACT_SELECTOR: LazyLock<String> =
    LazyLock::new(|| HIDDEN_EXACT_SELECTORS.join(","));
pub static HIDDEN_EXACT_SKIP_SELECTOR: LazyLock<String> =
    LazyLock::new(|| HIDDEN_EXACT_SKIP_SELECTORS.join(","));

/// `EXACT_SELECTORS`: elements removed outright. The four selectors after the "hidden" comment
/// are `...HIDDEN_EXACT_SELECTORS` of the JS source, spelled out because a Rust constant cannot
/// spread; a test pins them to the table above.
pub const EXACT_SELECTORS: &[&str] = &[
    // scripts, styles
    "noscript",
    r#"script:not([type^="math/"])"#,
    "style",
    "meta",
    "link",
    // empty media elements (src set by JS at runtime, not in raw HTML)
    "audio:not([src]):not(:has(source))",
    "video:not([src]):not(:has(source))",
    // JW Player embeds (removes entire player including controls, shortcuts, overlays)
    ".jwplayer",
    // ads
    r#".ad:not([class*="gradient"])"#,
    r#"[class^="ad-" i]"#,
    r#"[class$="-ad" i]"#,
    "[data-ad-wrapper]",
    r#"[id^="ad-" i]"#,
    r#"[id$="-ad" i]"#,
    r#"[role="banner" i]"#,
    r#"[alt*="advert" i]"#,
    ".promo",
    ".Promo",
    "#barrier-page", // ft.com
    ".alert",
    r#"[rel="sponsored" i]"#,
    r#"[href*="source=promotion" i]"#,
    // comments
    r#"[id="comments" i]"#,
    r#"[id="comment" i]"#,
    // cover images
    r#"div[class*="cover-"]"#,
    r#"div[id*="cover-"]"#,
    // breadcrumbs (custom web component tag)
    "ads-breadcrumbs",
    // header, nav
    // Exclude headers that contain multiple paragraphs — some sites (e.g. Webflow blogs)
    // use <header> as the main content wrapper rather than a navigation container.
    // A single <p> (subtitle/deck) is still a page header, not article content.
    "header:not(:has(p + p)):not(:has(img))",
    // Position-fixed/sticky headers are always site navigation (never content wrappers),
    // so they don't need the :not(:has(img)) guard — their images are logos/icons.
    r#"header[class~="fixed"]"#,
    r#"header[class~="sticky"]"#,
    ".header:not(.banner)",
    "#header",
    "#Header",
    "#banner",
    "#Banner",
    "nav",
    ".navigation",
    "#navigation",
    // '.hero', // see issue #132
    r#"[role="navigation" i]"#,
    r#"[role="dialog" i]"#,
    r#"[role="alertdialog" i]"#,
    r#"[role*="complementary" i]"#,
    r#"[class*="pagination" i]"#,
    ".menu",
    // '#menu', // see issue #106
    "#siteSub",
    // '.fixed', see issue #44
    ".previous",
    // metadata
    ".author",
    ".Author",
    r#"[class$="_bio"]"#,
    "#categories",
    ".contributor",
    ".date",
    "#date",
    "[data-date]",
    ".entry-meta",
    ".meta",
    ".tags",
    "#tags",
    r#"[rel="tag"]"#,
    ".headline",
    "#headline",
    "#title",
    "#Title",
    "#articleTag",
    // '[href*="/category"]', // see issue #131
    // '[href*="/categories"]', // see issue #131
    // '[href*="/tag/"]',
    // '[href*="/tags/"]',
    // '[href*="/topics"]', // see issue #131
    r#"[href*="/author/"]"#,
    r#"[href*="/author?"]"#,
    r#"[href$="/author"]"#,
    r#"a[href*="copyright.com"]"#,
    r#"a[href*="google.com/preferences"]"#,
    r##"[href="#top"]"##,
    r##"[href="#Top"]"##,
    r##"[href="#page-header"]"##,
    r##"[href="#content"]"##,
    r##"[href="#site-content"]"##,
    r##"[href="#main-content"]"##,
    r##"[href^="#main"]"##,
    r#"[src*="author"]"#,
    // table of contents
    ".toc",
    ".Toc",
    "#toc",
    r##"[href*="#toc"]"##,
    // footer
    "footer",
    // inputs, forms, elements
    ".aside",
    r#"aside:not([class*="callout"])"#,
    "button",
    // '[role="button"]', Medium images
    "canvas",
    "date",
    "dialog",
    "fieldset",
    "form",
    r#"input:not([type="checkbox"])"#,
    // UI toggle checkboxes (sidebar/menu/nav/drawer/hamburger patterns).
    // Markdown task list checkboxes use class="task-list-item-checkbox", so
    // none of these patterns affect them.
    r#"input[type="checkbox"][class*="sidebar" i]"#,
    r#"input[type="checkbox"][id*="sidebar" i]"#,
    r#"input[type="checkbox"][class*="drawer" i]"#,
    r#"input[type="checkbox"][id*="drawer" i]"#,
    r#"input[type="checkbox"][class*="hamburger" i]"#,
    r#"input[type="checkbox"][id*="hamburger" i]"#,
    r#"input[type="checkbox"][class*="toggle" i]"#,
    r#"input[type="checkbox"][id*="toggle" i]"#,
    r#"input[type="checkbox"][class*="trigger" i]"#,
    r#"input[type="checkbox"][id*="trigger" i]"#,
    "label",
    "option",
    "select",
    r#"[role="listbox"]"#,
    r#"[role="option"]"#,
    "textarea",
    // 'time', // see issue #136
    // 'relative-time', // see issue #136
    // hidden
    // ...HIDDEN_EXACT_SELECTORS
    "[hidden]",
    r#"[aria-hidden="true"]:not([class*="math"]):not(svg):not([class*="paywall"])"#,
    ".hidden",
    ".invisible",
    // Note: [style*="display: none"] removed — substring match causes false positives
    // with CSS custom properties like --footer-display: none. The removeHiddenElements
    // step handles inline style detection with a proper regex.
    // iframes
    "instaread-player",
    "iframe:not([src])",
    r#"iframe[src*="blink.net"]"#,
    r#"iframe[src*="giscus.app"]"#,
    r#"iframe[src*="tinypass.com"]"#,
    r#"iframe[src*="trinitymedia.ai"]"#,
    // logos
    r#"[class="logo" i]"#,
    "#logo",
    "#Logo",
    // newsletter
    "#newsletter",
    "#Newsletter",
    ".subscribe",
    // Substack inline clutter
    r#"[data-component-name="ButtonCreateButton"]"#,
    r#"[data-component-name="DigestPostEmbed"]"#,
    r#"[data-component-name="SubscribeWidgetToDOM"]"#,
    r#"[class*="digestPostEmbed"]"#, // class has hash suffix in browser-rendered DOM
    // hidden for print
    ".noprint",
    r#"[data-print-layout="hide" i]"#,
    r#"[data-block="donotprint" i]"#,
    // footnotes, citations
    r#"[class*="clickable-icon" i]"#,
    r#"li span[class*="ltx_tag" i][class*="ltx_tag_item" i]"#,
    r##"a[href^="#"][class*="anchor" i]"##,
    r##"a[href^="#"][class*="ref" i]:not(.ltx_ref):not(.footnote-backref)"##,
    // link lists
    r#"[data-container*="most-viewed" i]"#,
    // sidebar
    ".sidebar",
    ".Sidebar",
    "#sidebar",
    "#Sidebar",
    "#side-bar",
    "#secondary",
    "#sitesub",
    // sitemap
    r#"[href*="/sitemap/sitemap.xml"]"#, // Medium.com
    // skip links
    r#"[data-link-name*="skip" i]"#,
    r#"[aria-label*="skip" i]"#,
    // social
    r#"[title^="Share on" i]"#,
    // dismiss/close buttons
    r#"[aria-label="Dismiss" i]"#,
    r#"[aria-label="Close" i]"#,
    // icon SVGs (Font Awesome)
    "svg[data-icon]",
    // other
    r#"[data-testid="load-more-posts"] + div"#, // NY Times lazy loader
    ".copyright",
    "#copyright",
    ".licensebox",
    "#page-info",
    "#rss",
    "#feed",
    ".gutter",
    "#primaryaudio", // NPR
    "#NYT_ABOVE_MAIN_CONTENT_REGION",
    r#"[data-testid="photoviewer-children-figure"] > span"#, // NY Times
    "table.infobox",
    r#"[data-optimizely="related-articles-section" i]"#, // The Economist
    r#"[data-orientation="vertical"]"#,
    ".gh-header-sticky",                        // GitHub
    r#"[data-testid="issue-metadata-sticky"]"#, // GitHub
];

pub static EXACT_SELECTORS_JOINED: LazyLock<String> = LazyLock::new(|| EXACT_SELECTORS.join(","));

/// `FOOTNOTE_INLINE_REFERENCES` joined with `","`.
pub const FOOTNOTE_INLINE_REFERENCE_SELECTORS: &[&str] = &[
    "sup.reference",
    "cite.ltx_cite",
    r#"sup[id^="fnr"]"#,
    r#"span[id^="fnr"]"#,
    r#"span[class*="footnote_ref"]"#,
    r#"span[class*="footnote-ref"]"#,
    "span.footnote-link",
    "a.citation",
    r#"a[id^="ref-link"]"#,
    r##"a[href^="#fn"]"##,
    r##"a[href^="#cite"]"##,
    r##"a[href^="#reference"]"##,
    r##"a[href^="#footnote"]"##,
    r##"a[href^="#r"]"##, // Common in academic papers
    r##"a[href^="#b"]"##, // Common for bibliography references
    r#"a[href*="cite_note"]"#,
    r#"a[href*="cite_ref"]"#,
    "a.footnote-anchor",                // Substack
    "span.footnote-hovercard-target a", // Substack
    r#"a[role="doc-biblioref"]"#,       // Science.org
    r#"a[id^="fnref"]"#,
    r#"a[id^="ref-link"]"#,                      // Nature.com
    "sup.footnoteref",                           // Wikidot
    "sup.footnote-reference",                    // pulldown-cmark / mdBook / zola
    r##"sup[data-fn] > a[href^="#"]"##,          // WordPress block editor footnotes
    r##"sup[id^="ftnt_ref"] a[href^="#ftnt"]"##, // Google Docs/Sites
    r##"span.easy-footnote > a[href^="#easy-footnote-bottom-"]"##, // Easy Footnotes WP plugin
    r##"a.footnote[href^="#"]"##,                // GNU Texinfo / makeinfo inline markers
    r#"a[data-type="noteref"]"#,                 // O'Reilly / HTMLBook
];

pub static FOOTNOTE_INLINE_REFERENCES: LazyLock<String> =
    LazyLock::new(|| FOOTNOTE_INLINE_REFERENCE_SELECTORS.join(","));

/// `FOOTNOTE_LIST_SELECTORS` joined with `","`.
pub const FOOTNOTE_LIST_SELECTOR_LIST: &[&str] = &[
    "div.footnote ol",
    "div.footnotes ol",
    r#"div[role="doc-endnotes"]"#,
    r#"div[role="doc-footnotes"]"#,
    "ol.footnotes-list",
    "ol.footnotes",
    "ol.references",
    r#"ol[class*="article-references"]"#,
    "section.footnotes ol",
    r#"section[role="doc-endnotes"]"#,
    r#"section[role="doc-footnotes"]"#,
    r#"section[role="doc-bibliography"]"#,
    "ul.footnotes-list",
    "ul.ltx_biblist",
    r#"div.footnote[data-component-name="FootnoteToDOM"]"#, // Substack
    "div.footnotes-footer",                                 // Wikidot
    "div.footnote-definitions",
    "div.footnote-definition", // pulldown-cmark / mdBook / zola (unwrapped)
    "ol.wp-block-footnotes",   // WordPress block editor footnotes
    "ol.easy-footnotes-wrapper", // Easy Footnotes WP plugin
    "div.footnotes-segment",   // GNU Texinfo / makeinfo
    "#footnotes",              // standardizeFootnotes output container
];

pub static FOOTNOTE_LIST_SELECTORS: LazyLock<String> =
    LazyLock::new(|| FOOTNOTE_LIST_SELECTOR_LIST.join(","));
