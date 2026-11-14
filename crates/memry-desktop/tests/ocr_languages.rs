//! The OCR language packs against a local HTTP server standing in for the sync server's
//! `/ocr/v1/<lang>.traineddata.gz`. Ports `apps/desktop/src/main/file-text/ocr-languages.test.ts`
//! on the real client, the real files and the real config.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_desktop::locale::LocaleService;
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::transport::NativeTransport;
use memry_desktop::services::ocr_languages::{
    CACHE_DIR, DATA_DIR, OcrLanguage, OcrLanguageStatus, OcrLanguages, OcrLanguagesDeps,
    OcrLanguagesState, Pin,
};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use OcrLanguage::{Deu, Eng, Fra};

/// What the server answers for one language.
#[derive(Clone)]
enum Reply {
    /// 200 with the body, written in `pieces` writes.
    Body {
        bytes: Vec<u8>,
        pieces: usize,
    },
    Status(u16),
    /// Headers and one byte, then nothing until the client goes away.
    Stall,
}

struct Server {
    url: String,
    replies: Arc<Mutex<HashMap<String, Reply>>>,
    fetched: Arc<Mutex<Vec<String>>>,
}

impl Server {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        let replies: Arc<Mutex<HashMap<String, Reply>>> = Arc::default();
        let fetched: Arc<Mutex<Vec<String>>> = Arc::default();
        let (r, f) = (replies.clone(), fetched.clone());
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                tokio::spawn(answer(socket, r.clone(), f.clone()));
            }
        });
        Self {
            url,
            replies,
            fetched,
        }
    }

    fn reply(&self, lang: &str, reply: Reply) {
        self.replies
            .lock()
            .expect("replies")
            .insert(lang.to_owned(), reply);
    }

    fn fetched(&self) -> Vec<String> {
        self.fetched.lock().expect("fetched").clone()
    }
}

async fn answer(
    mut socket: tokio::net::TcpStream,
    replies: Arc<Mutex<HashMap<String, Reply>>>,
    fetched: Arc<Mutex<Vec<String>>>,
) {
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match socket.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    let line = String::from_utf8_lossy(&head);
    let path = line.split(' ').nth(1).unwrap_or_default().to_owned();
    fetched.lock().expect("fetched").push(path.clone());
    let lang = path
        .rsplit('/')
        .next()
        .and_then(|file| file.split('.').next())
        .unwrap_or_default()
        .to_owned();
    let reply = replies.lock().expect("replies").get(&lang).cloned();
    match reply {
        Some(Reply::Body { bytes, pieces }) => {
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                bytes.len()
            );
            let _ = socket.write_all(head.as_bytes()).await;
            for piece in bytes.chunks(bytes.len().div_ceil(pieces).max(1)) {
                let _ = socket.write_all(piece).await;
                let _ = socket.flush().await;
                // Pacing only, so the client reads the pieces as separate chunks.
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        Some(Reply::Status(status)) => {
            let head =
                format!("HTTP/1.1 {status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            let _ = socket.write_all(head.as_bytes()).await;
        }
        Some(Reply::Stall) => {
            let head = "HTTP/1.1 200 OK\r\ncontent-length: 1000\r\nconnection: close\r\n\r\nx";
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.flush().await;
            let _ = socket.read(&mut buf).await;
        }
        // Closes the connection unanswered: the server cannot be reached.
        None => {}
    }
}

fn gzip(text: &str) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(text.as_bytes()).expect("gzip");
    encoder.finish().expect("gzip")
}

fn pin_of(bytes: &[u8]) -> Pin {
    Pin {
        bytes: bytes.len() as u64,
        sha256: Box::leak(hex::encode(Sha256::digest(bytes)).into_boxed_str()),
    }
}

struct Fixture {
    server: Server,
    dir: tempfile::TempDir,
    config: Arc<AppConfig>,
    locale: Arc<LocaleService>,
    deu: Vec<u8>,
    fra: Vec<u8>,
    states: Arc<Mutex<Vec<OcrLanguagesState>>>,
    pins: &'static [(OcrLanguage, Pin)],
}

impl Fixture {
    async fn new() -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let server = Server::start().await;
        let deu = gzip("German model bytes");
        let fra = gzip("French model bytes");
        server.reply(
            "deu",
            Reply::Body {
                bytes: deu.clone(),
                pieces: 1,
            },
        );
        server.reply(
            "fra",
            Reply::Body {
                bytes: fra.clone(),
                pieces: 1,
            },
        );
        let dir = tempfile::tempdir().expect("tmp");
        let pins = Box::leak(vec![(Deu, pin_of(&deu)), (Fra, pin_of(&fra))].into_boxed_slice());
        Self {
            server,
            config: Arc::new(AppConfig::load(dir.path().join("memry-config.json"))),
            locale: Arc::new(LocaleService::new("en")),
            dir,
            deu,
            fra,
            states: Arc::default(),
            pins,
        }
    }

    fn service_with(&self, timeout: Duration) -> Arc<OcrLanguages> {
        let states = self.states.clone();
        OcrLanguages::new(OcrLanguagesDeps {
            config: self.config.clone(),
            locale: self.locale.clone(),
            app_data_dir: self.dir.path().to_path_buf(),
            server_url: self.server.url.clone(),
            transport: NativeTransport::loopback(),
            pins: self.pins,
            download_timeout: timeout,
            on_change: Box::new(move |state| states.lock().expect("states").push(state)),
            runtime: tokio::runtime::Handle::current(),
        })
    }

    fn service(&self) -> Arc<OcrLanguages> {
        self.service_with(Duration::from_secs(60))
    }

    fn data_dir(&self) -> PathBuf {
        self.dir.path().join(DATA_DIR)
    }

    fn fetched_langs(&self) -> Vec<String> {
        self.server.fetched()
    }
}

/// Polls `done` until it holds; the work under test runs on the service's own tasks.
async fn wait_until(done: impl Fn() -> bool) {
    for _ in 0..2000 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the condition never held");
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().to_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn failed(key: &str) -> OcrLanguageStatus {
    OcrLanguageStatus::Failed {
        error: format!("errors:ocrLanguages.{key}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_app_language_decides_until_the_user_chooses() {
    let fx = Fixture::new().await;
    let ocr = fx.service();
    assert_eq!(ocr.state().selected, [Eng]);

    fx.locale.switch("de");
    assert_eq!(ocr.state().selected, [Eng, Deu]);
    ocr.sync().await;

    assert_eq!(ocr.ready(), [Eng, Deu]);
    assert_eq!(fx.fetched_langs(), ["/ocr/v1/deu.traineddata.gz"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_download_that_matches_its_pin_is_kept_under_its_name() {
    let fx = Fixture::new().await;
    let ocr = fx.service();

    ocr.set(&[Deu]).expect("set");
    ocr.sync().await;

    let state = ocr.state();
    assert_eq!(state.selected, [Eng, Deu]);
    assert_eq!(state.statuses[&Deu], OcrLanguageStatus::Ready);
    assert_eq!(
        fx.config.ocr_languages(),
        Some(vec!["eng".into(), "deu".into()])
    );
    assert_eq!(names(&fx.data_dir()), ["deu.traineddata"]);
    assert_eq!(
        std::fs::read(fx.data_dir().join("deu.traineddata")).expect("pack"),
        fx.deu
    );
    assert!(
        fx.states
            .lock()
            .expect("states")
            .iter()
            .any(|s| s.statuses[&Deu]
                == OcrLanguageStatus::Downloading {
                    received_bytes: 0,
                    total_bytes: fx.deu.len() as u64
                })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_download_whose_sha256_differs_from_the_pin_is_refused() {
    let fx = Fixture::new().await;
    let mut tampered = fx.deu.clone();
    *tampered.last_mut().expect("byte") ^= 0xff;
    fx.server.reply(
        "deu",
        Reply::Body {
            bytes: tampered,
            pieces: 1,
        },
    );
    let ocr = fx.service();

    ocr.set(&[Eng, Deu]).expect("set");
    ocr.sync().await;

    assert_eq!(ocr.state().statuses[&Deu], failed("corrupt"));
    assert_eq!(ocr.ready(), [Eng]);
    assert_eq!(names(&fx.data_dir()), Vec::<String>::new());
    assert!(ocr.datapath(&[Deu]).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_download_keeps_the_others_and_retries_when_asked() {
    let fx = Fixture::new().await;
    fx.server.replies.lock().expect("replies").remove("fra");
    let ocr = fx.service();

    ocr.set(&[Deu, Fra]).expect("set");
    ocr.sync().await;
    assert_eq!(ocr.state().statuses[&Fra], failed("unreachable"));
    assert_eq!(ocr.ready(), [Eng, Deu]);

    fx.server.reply(
        "fra",
        Reply::Body {
            bytes: fx.fra.clone(),
            pieces: 1,
        },
    );
    ocr.sync().await;
    assert_eq!(ocr.ready(), [Eng, Deu]);

    ocr.retry();
    ocr.sync().await;
    assert_eq!(ocr.ready(), [Eng, Deu, Fra]);
    let fra_fetches = fx
        .fetched_langs()
        .iter()
        .filter(|path| path.ends_with("/fra.traineddata.gz"))
        .count();
    assert_eq!(fra_fetches, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_language_no_longer_chosen_loses_its_pack_and_its_unpacked_data() {
    let fx = Fixture::new().await;
    let ocr = fx.service();
    ocr.set(&[Deu]).expect("set");
    ocr.sync().await;
    let datapath = ocr.datapath(&[Eng, Deu]).expect("datapath");
    assert_eq!(datapath, fx.dir.path().join(CACHE_DIR));
    assert!(datapath.join("deu.traineddata").is_file());
    // A leftover of a download an earlier run never finished.
    std::fs::write(fx.data_dir().join("fra.1234.part"), b"half").expect("part");

    ocr.set(&[Eng]).expect("set");
    ocr.sync().await;

    assert_eq!(ocr.ready(), [Eng]);
    assert_eq!(names(&fx.data_dir()), Vec::<String>::new());
    assert_eq!(names(&datapath), Vec::<String>::new());
    assert_eq!(fx.fetched_langs().len(), 1);
}

/// An earlier run, Electron's included: the pack is the gzip the server served.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pack_an_earlier_run_downloaded_is_used_without_a_fetch_and_unpacks() {
    let fx = Fixture::new().await;
    std::fs::create_dir_all(fx.data_dir()).expect("dir");
    std::fs::write(fx.data_dir().join("deu.traineddata"), &fx.deu).expect("pack");
    fx.config
        .set_ocr_languages(&["eng".into(), "deu".into()])
        .expect("config");
    let ocr = fx.service();

    ocr.sync().await;

    assert_eq!(ocr.ready(), [Eng, Deu]);
    assert!(fx.fetched_langs().is_empty());
    let datapath = ocr.datapath(&[Deu]).expect("datapath");
    assert_eq!(
        std::fs::read_to_string(datapath.join("deu.traineddata")).expect("unpacked"),
        "German model bytes"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_locale_change_downloads_the_new_app_language_when_nothing_was_chosen() {
    let fx = Fixture::new().await;
    let ocr = fx.service();
    ocr.sync().await;
    assert!(fx.fetched_langs().is_empty());

    fx.locale.switch("fr");
    ocr.locale_changed();
    // No `sync` here: the locale change alone starts the pass.
    wait_until(|| ocr.ready() == [Eng, Fra]).await;
    assert_eq!(fx.fetched_langs(), ["/ocr/v1/fra.traineddata.gz"]);
    assert_eq!(
        fx.states
            .lock()
            .expect("states")
            .last()
            .map(|s| s.selected.clone()),
        Some(vec![Eng, Fra])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_download_cancelled_by_removing_its_language_leaves_nothing() {
    let fx = Fixture::new().await;
    fx.server.reply("deu", Reply::Stall);
    let ocr = fx.service_with(Duration::from_secs(3600));

    ocr.set(&[Deu]).expect("set");
    wait_until(|| !fx.fetched_langs().is_empty()).await;
    ocr.set(&[]).expect("set");
    // timing-bound: an unstopped download would hold the pass for its hour-long deadline.
    tokio::time::timeout(Duration::from_secs(30), ocr.sync())
        .await
        .expect("removing the language stops its download");

    assert_eq!(ocr.state().selected, [Eng]);
    assert_eq!(ocr.state().statuses.len(), 1);
    assert_eq!(names(&fx.data_dir()), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_download_past_its_deadline_fails_and_leaves_nothing() {
    let fx = Fixture::new().await;
    fx.server.reply("deu", Reply::Stall);
    let ocr = fx.service_with(Duration::from_millis(300));

    ocr.set(&[Deu]).expect("set");
    ocr.sync().await;

    assert_eq!(ocr.state().statuses[&Deu], failed("unreachable"));
    assert_eq!(names(&fx.data_dir()), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pack_that_no_longer_matches_its_pin_is_downloaded_again() {
    let fx = Fixture::new().await;
    std::fs::create_dir_all(fx.data_dir()).expect("dir");
    std::fs::write(fx.data_dir().join("deu.traineddata"), b"older model").expect("pack");
    fx.config
        .set_ocr_languages(&["eng".into(), "deu".into()])
        .expect("config");
    let ocr = fx.service();

    ocr.sync().await;

    assert_eq!(ocr.ready(), [Eng, Deu]);
    assert_eq!(fx.fetched_langs().len(), 1);
    assert_eq!(
        std::fs::read(fx.data_dir().join("deu.traineddata")).expect("pack"),
        fx.deu
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_language_the_server_answers_404_for_is_unavailable() {
    let fx = Fixture::new().await;
    fx.server.reply("deu", Reply::Status(404));
    let ocr = fx.service();

    ocr.set(&[Deu]).expect("set");
    ocr.sync().await;

    assert_eq!(ocr.state().statuses[&Deu], failed("unavailable"));
}
