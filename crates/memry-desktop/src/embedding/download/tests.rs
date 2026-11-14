//! The download against a local HTTP fake of the model host: never the real CDN.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::*;

const REPO: &str = "onnx-community/model";
const REVISION: &str = "abc123";
/// A hang guard, never a bound on how fast the code is.
const HANG: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Serve,
    /// The next answer promises the whole file, sends this many bytes, and closes.
    CutOnceAfter(usize),
    /// Every answer sends this many bytes, then nothing, never closing.
    StallAfter(usize),
    /// Every answer is the whole file with a 200, whatever the range.
    IgnoreRange,
}

struct Fake {
    url: String,
    files: HashMap<String, Vec<u8>>,
    mode: Mutex<Mode>,
    /// The path and `Range` header of every request.
    seen: Mutex<Vec<(String, Option<String>)>>,
}

impl Fake {
    async fn start(files: &[(&str, Vec<u8>)], mode: Mode) -> Arc<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fake = Arc::new(Self {
            url: format!("http://{}", listener.local_addr().unwrap()),
            files: files
                .iter()
                .map(|(path, bytes)| ((*path).to_owned(), bytes.clone()))
                .collect(),
            mode: Mutex::new(mode),
            seen: Mutex::default(),
        });
        let server = fake.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(server.clone().answer(stream));
            }
        });
        fake
    }

    fn seen(&self) -> Vec<(String, Option<String>)> {
        self.seen.lock().unwrap().clone()
    }

    async fn answer(self: Arc<Self>, mut stream: TcpStream) {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                return;
            }
            head.push(byte[0]);
        }
        let head = String::from_utf8(head).unwrap();
        let target = head.split(' ').nth(1).unwrap().to_owned();
        let range = head.lines().find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("range: ")
                .map(str::to_owned)
        });
        let prefix = format!("/{REPO}/resolve/{REVISION}/");
        let path = target.strip_prefix(&prefix).unwrap().to_owned();
        self.seen
            .lock()
            .unwrap()
            .push((path.clone(), range.clone()));
        let Some(body) = self.files.get(&path) else {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await;
            return;
        };
        let mode = std::mem::replace(&mut *self.mode.lock().unwrap(), Mode::Serve);
        if !matches!(mode, Mode::CutOnceAfter(_)) {
            *self.mode.lock().unwrap() = mode;
        }
        let start = match (
            mode,
            range.as_deref().and_then(|r| r.strip_prefix("bytes=")),
        ) {
            (Mode::IgnoreRange, _) | (_, None) => None,
            (_, Some(r)) => Some(r.trim_end_matches('-').parse::<usize>().unwrap()),
        };
        let (status, rest, extra) = match start {
            Some(from) => (
                "206 Partial Content",
                &body[from..],
                format!(
                    "content-range: bytes {from}-{}/{}\r\n",
                    body.len() - 1,
                    body.len()
                ),
            ),
            None => ("200 OK", &body[..], String::new()),
        };
        let header = format!(
            "HTTP/1.1 {status}\r\ncontent-length: {}\r\n{extra}connection: close\r\n\r\n",
            rest.len()
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        match mode {
            Mode::CutOnceAfter(n) | Mode::StallAfter(n) => {
                let _ = stream.write_all(&rest[..n.min(rest.len())]).await;
                let _ = stream.flush().await;
                if let Mode::StallAfter(_) = mode {
                    std::future::pending::<()>().await;
                }
            }
            Mode::Serve | Mode::IgnoreRange => {
                let _ = stream.write_all(rest).await;
            }
        }
    }
}

fn bytes(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

fn pin(path: &str, body: &[u8]) -> PinnedFile {
    PinnedFile {
        path: path.to_owned(),
        size: body.len() as u64,
        sha256: hex::encode(Sha256::digest(body)),
    }
}

struct Case {
    _dir: tempfile::TempDir,
    source: ModelSource,
    events: Arc<Mutex<Vec<ModelProgress>>>,
}

impl Case {
    fn new(fake: &Fake, files: Vec<PinnedFile>) -> Self {
        // The shell installs this at boot (`install_crypto_provider`).
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = tempfile::Builder::new()
            .prefix("memry-model-download")
            .tempdir()
            .unwrap();
        let source = ModelSource::new(&fake.url, REPO, REVISION, dir.path().join("model"), files);
        Self {
            _dir: dir,
            source,
            events: Arc::default(),
        }
    }

    fn path(&self, rel: &str) -> PathBuf {
        file_path(self.source.dir(), rel)
    }

    async fn ensure_with(&self, abort: &Abort) -> Result<(), DownloadError> {
        let events = self.events.clone();
        let sink = move |event: ModelProgress| events.lock().unwrap().push(event);
        tokio::time::timeout(HANG, self.source.ensure(abort, &sink))
            .await
            .expect("the download hung")
    }

    async fn ensure(&self) -> Result<(), DownloadError> {
        self.ensure_with(&abort_after(HANG)).await
    }
}

fn abort_after(after: Duration) -> Abort {
    Abort {
        cancel: CancellationToken::new(),
        deadline: Instant::now() + after,
    }
}

#[tokio::test]
async fn downloads_each_file_into_the_cache_layout_with_weighted_progress() {
    let (tokenizer, weights) = (bytes(3000, 1), bytes(1000, 2));
    let fake = Fake::start(
        &[
            ("tokenizer.json", tokenizer.clone()),
            ("onnx/model.onnx_data", weights.clone()),
        ],
        Mode::Serve,
    )
    .await;
    let case = Case::new(
        &fake,
        vec![
            pin("tokenizer.json", &tokenizer),
            pin("onnx/model.onnx_data", &weights),
        ],
    );
    case.ensure().await.expect("downloaded");

    assert_eq!(fs::read(case.path("tokenizer.json")).unwrap(), tokenizer);
    assert_eq!(
        fs::read(case.path("onnx/model.onnx_data")).unwrap(),
        weights
    );
    assert!(!part_path(&case.path("tokenizer.json")).exists());
    let events = case.events.lock().unwrap().clone();
    let percents: Vec<u8> = events
        .iter()
        .filter(|e| e.phase == Phase::Downloading)
        .map(|e| e.progress)
        .collect();
    assert!(
        percents.contains(&75),
        "the tokenizer is 75% of the group: {percents:?}"
    );
    assert_eq!(percents.last(), Some(&100));
    assert!(percents.windows(2).all(|w| w[0] < w[1]), "{percents:?}");
    assert_eq!(
        events.last(),
        Some(&ModelProgress::new(
            Phase::Loading,
            95,
            "Finalizing model..."
        ))
    );

    // Present and verified: a second load asks the host for nothing.
    case.ensure().await.expect("present");
    assert_eq!(fake.seen().len(), 2);
}

#[tokio::test]
async fn a_cut_connection_resumes_from_the_part_file_with_a_range_request() {
    let weights = bytes(50_000, 3);
    let fake = Fake::start(
        &[("onnx/model.onnx_data", weights.clone())],
        Mode::CutOnceAfter(20_000),
    )
    .await;
    let case = Case::new(&fake, vec![pin("onnx/model.onnx_data", &weights)]);

    case.ensure().await.expect_err("the connection was cut");
    let part = part_path(&case.path("onnx/model.onnx_data"));
    assert_eq!(fs::metadata(&part).unwrap().len(), 20_000);
    assert!(!case.path("onnx/model.onnx_data").exists());

    case.ensure().await.expect("resumed");
    assert_eq!(
        fs::read(case.path("onnx/model.onnx_data")).unwrap(),
        weights
    );
    assert!(!part.exists());
    assert_eq!(
        fake.seen(),
        [
            ("onnx/model.onnx_data".to_owned(), None),
            (
                "onnx/model.onnx_data".to_owned(),
                Some("bytes=20000-".to_owned())
            ),
        ]
    );
}

#[tokio::test]
async fn a_host_that_ignores_the_range_restarts_the_file() {
    let weights = bytes(4096, 4);
    let fake = Fake::start(&[("w.bin", weights.clone())], Mode::IgnoreRange).await;
    let case = Case::new(&fake, vec![pin("w.bin", &weights)]);
    let part = part_path(&case.path("w.bin"));
    fs::create_dir_all(part.parent().unwrap()).unwrap();
    fs::write(&part, &weights[..1000]).unwrap();

    case.ensure().await.expect("downloaded whole");
    assert_eq!(fs::read(case.path("w.bin")).unwrap(), weights);
}

#[tokio::test]
async fn a_wrong_hash_deletes_the_part_file_and_names_the_file() {
    let weights = bytes(2048, 5);
    let fake = Fake::start(&[("onnx/model.onnx_data", weights.clone())], Mode::Serve).await;
    let mut pinned = pin("onnx/model.onnx_data", &weights);
    pinned.sha256 = hex::encode(Sha256::digest(b"other"));
    let case = Case::new(&fake, vec![pinned]);

    let error = case.ensure().await.expect_err("the hash differs");
    assert!(
        matches!(&error, DownloadError::HashMismatch { file } if file == "onnx/model.onnx_data"),
        "{error:?}"
    );
    assert!(error.to_string().contains("onnx/model.onnx_data"));
    assert!(!case.path("onnx/model.onnx_data").exists());
    assert!(!part_path(&case.path("onnx/model.onnx_data")).exists());
}

#[tokio::test]
async fn a_host_sending_more_than_the_pinned_size_fails_without_keeping_the_bytes() {
    let served = bytes(3000, 6);
    let fake = Fake::start(&[("w.bin", served.clone())], Mode::Serve).await;
    let case = Case::new(&fake, vec![pin("w.bin", &served[..1000])]);

    let error = case.ensure().await.expect_err("too large");
    assert!(matches!(error, DownloadError::TooLarge { .. }), "{error:?}");
    assert!(!part_path(&case.path("w.bin")).exists());
}

/// An Electron profile's transformers.js cache has the same layout: its files are used when
/// their hash matches and fetched again when it does not.
#[tokio::test]
async fn reuses_electron_layout_files_only_when_their_hash_matches() {
    let (tokenizer, weights) = (bytes(1500, 7), bytes(2500, 8));
    let fake = Fake::start(
        &[
            ("tokenizer.json", tokenizer.clone()),
            ("onnx/model.onnx_data", weights.clone()),
        ],
        Mode::Serve,
    )
    .await;
    let case = Case::new(
        &fake,
        vec![
            pin("tokenizer.json", &tokenizer),
            pin("onnx/model.onnx_data", &weights),
        ],
    );
    fs::create_dir_all(case.path("onnx")).unwrap();
    fs::write(case.path("tokenizer.json"), &tokenizer).unwrap();
    // Right size, wrong bytes: what a torn or tampered file looks like to a size check.
    fs::write(case.path("onnx/model.onnx_data"), bytes(2500, 9)).unwrap();

    case.ensure().await.expect("repaired");
    assert_eq!(
        fs::read(case.path("onnx/model.onnx_data")).unwrap(),
        weights
    );
    assert_eq!(fake.seen(), [("onnx/model.onnx_data".to_owned(), None)]);
}

#[tokio::test]
async fn the_deadline_ends_a_stalled_download_and_keeps_the_part_file() {
    let weights = bytes(8192, 10);
    let fake = Fake::start(&[("w.bin", weights.clone())], Mode::StallAfter(512)).await;
    let case = Case::new(&fake, vec![pin("w.bin", &weights)]);

    let error = case
        .ensure_with(&abort_after(Duration::from_millis(300)))
        .await
        .expect_err("stalled");
    assert!(
        matches!(error, DownloadError::DeadlineExceeded),
        "{error:?}"
    );
    assert_eq!(
        fs::metadata(part_path(&case.path("w.bin"))).unwrap().len(),
        512
    );
}

#[tokio::test]
async fn cancelling_ends_a_stalled_download() {
    let weights = bytes(8192, 11);
    let fake = Fake::start(&[("w.bin", weights.clone())], Mode::StallAfter(256)).await;
    let case = Case::new(&fake, vec![pin("w.bin", &weights)]);
    let abort = abort_after(HANG);
    let cancel = abort.cancel.clone();
    let part = part_path(&case.path("w.bin"));
    let watcher = tokio::spawn(async move {
        while fs::metadata(&part).map_or(0, |m| m.len()) < 256 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        cancel.cancel();
    });

    let error = case.ensure_with(&abort).await.expect_err("cancelled");
    assert!(matches!(error, DownloadError::Cancelled), "{error:?}");
    watcher.await.unwrap();
}

#[tokio::test]
async fn a_missing_file_is_an_http_error_naming_it() {
    let fake = Fake::start(&[], Mode::Serve).await;
    let case = Case::new(&fake, vec![pin("gone.bin", b"x")]);
    let error = case.ensure().await.expect_err("404");
    assert!(
        matches!(&error, DownloadError::Http { file, status: 404 } if file == "gone.bin"),
        "{error:?}"
    );
}
