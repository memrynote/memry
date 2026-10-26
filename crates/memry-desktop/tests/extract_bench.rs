//! Time bound of `extract_article` on a large page: a 1 MB page under 150 ms and a 100 KB page
//! under 25 ms (median of 5 runs, release build, the targets set on an M1). The page repeats the
//! body of the long-read fixture. Run with
//! `cargo test -p memry-desktop --release --test extract_bench -- --ignored --nocapture`.

use std::time::{Duration, Instant};
use std::{fs, path::PathBuf};

use memry_desktop::web::extract::extract_article;
use memry_desktop::web::extract::fetch::{FetchRequest, FetchResponse, Fetcher};

struct NoNetwork;

impl Fetcher for NoNetwork {
    fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, String> {
        Err(format!("unexpected request {}", request.url))
    }
}

fn page_of(bytes: usize) -> (String, String) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/article-extract/long-read-images");
    let html = fs::read_to_string(dir.join("page.html")).unwrap();
    let url = fs::read_to_string(dir.join("url.txt")).unwrap();
    let start = html.find("<article").unwrap();
    let end = html.find("</article>").unwrap() + "</article>".len();
    let (head, body, tail) = (&html[..start], &html[start..end], &html[end..]);
    let article = &body[body.find('>').unwrap() + 1..body.len() - "</article>".len()];
    let copies = bytes.saturating_sub(head.len() + tail.len()) / article.len() + 1;
    let repeated = format!(
        "{head}<article class=\"longform\">{}</article>{tail}",
        article.repeat(copies)
    );
    (repeated, url.trim().to_string())
}

fn median_of_five(html: &str, url: &str) -> Duration {
    let mut times: Vec<Duration> = (0..5)
        .map(|_| {
            let started = Instant::now();
            let capture = extract_article(html, url, "2025-03-04T05:06:07.000Z", &NoNetwork);
            let elapsed = started.elapsed();
            assert!(
                !capture.content_markdown.is_empty(),
                "the page extracted nothing"
            );
            elapsed
        })
        .collect();
    times.sort();
    times[2]
}

#[test]
#[ignore = "timing bound; run in release mode"]
fn extract_bench() {
    for (bytes, limit) in [(100_000, 25), (1_000_000, 150)] {
        let (html, url) = page_of(bytes);
        let median = median_of_five(&html, &url);
        println!("{} bytes: median {median:?} (limit {limit} ms)", html.len());
        assert!(
            median < Duration::from_millis(limit),
            "{} bytes took {median:?}, limit {limit} ms",
            html.len()
        );
    }
}
