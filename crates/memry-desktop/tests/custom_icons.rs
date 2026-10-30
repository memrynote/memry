//! The custom icon library on a real vault (`data.db` through the core, `.memry/icons` on disk) and
//! the link download against a local HTTP server.
//!
//! | Test                                                         | Rule                                  |
//! | ------------------------------------------------------------ | ------------------------------------- |
//! | a raster is stored as a png whose longest edge is 128         | `custom-icon-handlers.ts:57`          |
//! | a small raster keeps its size                                 | downscale only, never upscale         |
//! | an svg is stored sanitized                                    | inert record and file                 |
//! | an svg with nothing usable is refused and stores nothing      | corrupt-icon error                    |
//! | an empty or oversized upload is refused                       | `CUSTOM_ICON_MAX_INPUT_BYTES`         |
//! | a decompression bomb is refused                               | decoded size bound                    |
//! | list rebuilds a missing file from the record                  | rehydrate on list                     |
//! | rename keeps the file, delete removes it once                 | `{ success: false }` on a second try  |
//! | a link: content type, extension fallback, name                | `remote-icon.ts`                      |
//! | a body over the cap is refused, length header or not          | bounded read                          |
//! | a host that stalls times out                                  | 10 s timeout, here 300 ms             |
//! | a link that is not an image is refused                        | stricter than Electron (module doc)   |

use std::collections::HashMap;
use std::io::{Cursor, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use image::{DynamicImage, ImageFormat, RgbImage};
use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::SecureStoreError;
use memry_core::api::vault::Vault;
use memry_core::domain::custom_icons::CustomIconStore;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::notes::icons::{
    self, CustomIconError, Library, MAX_DECODED_BYTES, MAX_INPUT_BYTES, download_within, normalize,
};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;

const NOW: i64 = 1_760_000_000_000;

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<SecureStoreKey, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.0.lock().unwrap().get(&key).cloned())
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().insert(key, value);
        Ok(())
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().remove(&key);
        Ok(())
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
}

struct Lib {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    icons: Library,
    /// The core's records under the library, to read what the payload holds.
    records: CustomIconStore,
}

fn library() -> Lib {
    let dir = tempfile::Builder::new()
        .prefix("memry-custom-icons-")
        .tempdir()
        .expect("tmp");
    let vault = dir.path().join("vault");
    let core = vault.join(".memry").join("core");
    std::fs::create_dir_all(&core).expect("vault dirs");
    let store: Arc<dyn SecureStore> = Arc::new(MemoryStore::default());
    ensure_device_identity(store.clone()).expect("device identity");
    let core =
        Vault::open("vault".into(), core.to_string_lossy().into_owned()).expect("open data.db");
    let records = core.custom_icons(store.clone()).expect("icon store");
    Lib {
        icons: Library::new(vault.clone(), core.custom_icons(store).expect("icon store")),
        records,
        _dir: dir,
        vault,
    }
}

fn encoded(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), format)
        .expect("encode");
    bytes
}

fn rgb(width: u32, height: u32) -> DynamicImage {
    DynamicImage::ImageRgb8(RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 90])
    }))
}

fn stored_png(path: &Path) -> (u32, u32) {
    let bytes = std::fs::read(path).expect("icon file");
    assert_eq!(image::guess_format(&bytes).ok(), Some(ImageFormat::Png));
    let image = image::load_from_memory(&bytes).expect("a readable png");
    (image.width(), image.height())
}

fn files(vault: &Path) -> Vec<String> {
    let Ok(dir) = std::fs::read_dir(vault.join(".memry").join("icons")) else {
        return Vec::new();
    };
    dir.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

#[test]
fn a_raster_is_stored_as_a_png_whose_longest_edge_is_128() {
    let lib = library();
    let cases = [
        (encoded(&rgb(600, 300), ImageFormat::Png), "png", (128, 64)),
        (
            encoded(&rgb(500, 1000), ImageFormat::Jpeg),
            "jpg",
            (64, 128),
        ),
        (
            encoded(&rgb(129, 129), ImageFormat::WebP),
            "webp",
            (128, 128),
        ),
    ];
    for (bytes, ext, size) in cases {
        let icon = lib.icons.add(&bytes, ext, "Photo", NOW).expect("added");
        assert_eq!(icon.ext, "png");
        assert_eq!(stored_png(Path::new(&icon.path)), size, "{ext}");
        let record = lib.records.list().unwrap();
        let data = &record.icons.iter().find(|i| i.id == icon.id).unwrap().data;
        assert_eq!(
            STANDARD.decode(data).unwrap(),
            std::fs::read(&icon.path).unwrap(),
            "the record and the file hold the same bytes"
        );
    }
}

#[test]
fn a_small_raster_keeps_its_size() {
    let lib = library();
    let gif = encoded(&rgb(40, 20), ImageFormat::Gif);
    // The format comes from the bytes; the extension the picker sent is only "not svg".
    let icon = lib.icons.add(&gif, "png", "Tiny", NOW).expect("added");
    assert_eq!(stored_png(Path::new(&icon.path)), (40, 20));
    assert_eq!(icon.name, "Tiny");
}

#[test]
fn an_svg_is_stored_sanitized() {
    let lib = library();
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" onclick="steal()"/></svg>"#;
    let icon = lib.icons.add(svg, "svg", "Logo", NOW).expect("added");
    assert_eq!(icon.ext, "svg");
    let file = std::fs::read_to_string(&icon.path).expect("icon file");
    assert!(file.contains("<rect"), "{file}");
    assert!(
        !file.contains("script") && !file.contains("onclick"),
        "{file}"
    );
    let data = &lib.records.list().unwrap().icons[0].data;
    assert_eq!(STANDARD.decode(data).unwrap(), file.as_bytes());
}

#[test]
fn an_svg_with_nothing_usable_is_refused_and_stores_nothing() {
    let lib = library();
    for bytes in [
        &b"<html><body>a page</body></html>"[..],
        b"<script>x()</script>",
    ] {
        let refused = lib.icons.add(bytes, "svg", "Page", NOW);
        assert!(
            matches!(refused, Err(CustomIconError::Unreadable)),
            "{refused:?}"
        );
    }
    assert_eq!(lib.icons.list().unwrap(), []);
    assert_eq!(files(&lib.vault), Vec::<String>::new());
}

#[test]
fn an_empty_oversized_or_unknown_upload_is_refused() {
    let lib = library();
    let png = encoded(&rgb(8, 8), ImageFormat::Png);
    let mut oversized = png.clone();
    oversized.resize(MAX_INPUT_BYTES + 1, 0);
    for (bytes, ext) in [(&[][..], "png"), (&oversized[..], "png")] {
        assert!(matches!(
            normalize(bytes, ext),
            Err(CustomIconError::TooLarge)
        ));
    }
    for (bytes, ext) in [(&png[..], "bmp"), (&b"not an image"[..], "png")] {
        assert!(matches!(
            normalize(bytes, ext),
            Err(CustomIconError::Unreadable)
        ));
    }
    assert!(lib.icons.add(&oversized, "png", "Big", NOW).is_err());
    assert_eq!(lib.records.list().unwrap().icons, []);
}

/// A real PNG whose pixels need more than the decode bound, in well under 2 MiB: grey rows of
/// zeros compress about a thousand times.
fn bomb(side: u32) -> Vec<u8> {
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut crc = flate2::Crc::new();
        crc.update(kind);
        crc.update(data);
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&crc.sum().to_be_bytes());
    }
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&side.to_be_bytes());
    ihdr.extend_from_slice(&side.to_be_bytes());
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]); // 8-bit greyscale
    let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    let row = vec![0u8; side as usize + 1]; // filter byte, then the pixels
    for _ in 0..side {
        zlib.write_all(&row).unwrap();
    }
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut png, b"IHDR", &ihdr);
    chunk(&mut png, b"IDAT", &zlib.finish().unwrap());
    chunk(&mut png, b"IEND", &[]);
    png
}

#[test]
fn a_decompression_bomb_is_refused() {
    // 12000 x 12000 grey is 144 MB of pixels: over the bound, under `image`'s own 512 MiB default
    // and under the 16384 px edge, so only the decode bound stands between it and the allocation.
    let side = 12_000;
    assert!(u64::from(side) * u64::from(side) > MAX_DECODED_BYTES);
    let png = bomb(side);
    assert!(png.len() < MAX_INPUT_BYTES, "{} bytes", png.len());

    assert!(matches!(
        normalize(&png, "png"),
        Err(CustomIconError::Unreadable)
    ));
}

#[test]
fn list_rebuilds_a_missing_file_from_the_record() {
    let lib = library();
    let png = encoded(&rgb(300, 300), ImageFormat::Png);
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>"#;
    let a = lib.icons.add(&png, "png", "A", NOW).unwrap();
    let b = lib.icons.add(svg, "svg", "B", NOW + 1).unwrap();
    let kept: Vec<Vec<u8>> = [&a.path, &b.path]
        .iter()
        .map(|p| std::fs::read(p).unwrap())
        .collect();
    std::fs::remove_dir_all(lib.vault.join(".memry").join("icons")).unwrap();

    let listed = lib.icons.list().unwrap();

    assert_eq!(listed, [a.clone(), b.clone()]);
    for (icon, bytes) in [&a, &b].iter().zip(kept) {
        assert_eq!(std::fs::read(&icon.path).unwrap(), bytes, "{}", icon.name);
    }
}

#[test]
fn rename_keeps_the_file_and_delete_removes_it_once() {
    let lib = library();
    let png = encoded(&rgb(10, 10), ImageFormat::Png);
    let icon = lib.icons.add(&png, "png", "Old", NOW).unwrap();

    let renamed = lib.icons.rename(&icon.id, "  New  ", NOW + 1).unwrap();
    assert_eq!((renamed.name.as_str(), &renamed.path), ("New", &icon.path));
    assert!(Path::new(&icon.path).is_file());

    assert!(lib.icons.delete(&icon.id, NOW + 2).unwrap());
    assert!(!Path::new(&icon.path).exists());
    assert!(!lib.icons.delete(&icon.id, NOW + 3).unwrap());
    assert_eq!(lib.icons.list().unwrap(), []);
}

/// What the local server answers.
#[derive(Clone)]
enum Reply {
    /// A full response; `length: false` sends the body chunked, with no `Content-Length`.
    Body {
        status: u16,
        content_type: Option<&'static str>,
        body: Vec<u8>,
        length: bool,
    },
    /// Headers that claim `declared` bytes, then a few, then the connection closes.
    Claims { declared: usize },
    /// Nothing at all, or headers and a few bytes, then silence with the connection held open.
    Stall { headers: bool },
}

fn ok(content_type: Option<&'static str>, body: Vec<u8>) -> Reply {
    Reply::Body {
        status: 200,
        content_type,
        body,
        length: true,
    }
}

async fn answer(mut socket: tokio::net::TcpStream, reply: Reply) -> std::io::Result<()> {
    let mut request = Vec::new();
    let mut buf = [0u8; 1024];
    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = socket.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        request.extend_from_slice(&buf[..n]);
    }
    let hold = || tokio::time::sleep(Duration::from_secs(3600));
    match reply {
        Reply::Body {
            status,
            content_type,
            body,
            length,
        } => {
            let mut head = format!("HTTP/1.1 {status} X\r\nConnection: close\r\n");
            if let Some(kind) = content_type {
                head += &format!("Content-Type: {kind}\r\n");
            }
            if length {
                head += &format!("Content-Length: {}\r\n\r\n", body.len());
                socket.write_all(head.as_bytes()).await?;
                socket.write_all(&body).await?;
            } else {
                head += "Transfer-Encoding: chunked\r\n\r\n";
                socket.write_all(head.as_bytes()).await?;
                for part in body.chunks(64 * 1024) {
                    socket
                        .write_all(format!("{:x}\r\n", part.len()).as_bytes())
                        .await?;
                    socket.write_all(part).await?;
                    socket.write_all(b"\r\n").await?;
                }
                socket.write_all(b"0\r\n\r\n").await?;
            }
        }
        Reply::Claims { declared } => {
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {declared}\r\n\r\n"
            );
            socket.write_all(head.as_bytes()).await?;
            socket.write_all(&[0u8; 16]).await?;
        }
        Reply::Stall { headers } => {
            if headers {
                let head =
                    "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4096\r\n\r\n";
                socket.write_all(head.as_bytes()).await?;
                socket.write_all(&[0u8; 16]).await?;
            }
            hold().await;
        }
    }
    socket.shutdown().await
}

/// Serves `reply` to every connection and returns the base URL.
async fn serve(reply: Reply) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(answer(socket, reply.clone()));
        }
    });
    format!("http://{addr}")
}

fn client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    memry_desktop::http::builder()
        .no_proxy()
        .build()
        .expect("client")
}

async fn fetch(url: &str) -> Result<icons::RemoteIcon, CustomIconError> {
    download_within(&client(), url, Duration::from_secs(10)).await
}

#[tokio::test]
async fn a_link_is_typed_by_its_content_type_then_its_extension_and_named_by_its_file() {
    let png = encoded(&rgb(200, 100), ImageFormat::Png);
    let base = serve(ok(Some("image/png; charset=binary"), png.clone())).await;
    let icon = fetch(&format!("{base}/img/My%20Logo.v2.png?x=1"))
        .await
        .expect("downloaded");
    assert_eq!((icon.ext, icon.name.as_str()), ("png", "My Logo.v2"));
    assert_eq!(icon.bytes, png);

    let generic = serve(ok(Some("application/octet-stream"), png.clone())).await;
    assert_eq!(
        fetch(&format!("{generic}/a.JPEG")).await.unwrap().ext,
        "jpg"
    );
    let untyped = serve(ok(None, png.clone())).await;
    let icon = fetch(&format!("{untyped}/")).await;
    assert!(
        matches!(icon, Err(CustomIconError::UnsupportedUrl)),
        "{icon:?}"
    );
    let icon = fetch(&format!("{untyped}/icon.svg")).await.unwrap();
    assert_eq!(icon.ext, "svg");
    assert_eq!(icon.name, "icon");

    // Stored like an upload: re-encoded, the link forgotten.
    let lib = library();
    let remote = fetch(&format!("{base}/logo.png")).await.unwrap();
    let stored = lib
        .icons
        .add(&remote.bytes, remote.ext, &remote.name, NOW)
        .unwrap();
    assert_eq!(
        (stored.name.as_str(), stored_png(Path::new(&stored.path))),
        ("logo", (128, 64))
    );
}

#[tokio::test]
async fn a_body_over_the_cap_is_refused_whatever_its_length_header_says() {
    let over = vec![7u8; MAX_INPUT_BYTES + 1];
    for length in [true, false] {
        let base = serve(Reply::Body {
            status: 200,
            content_type: Some("image/png"),
            body: over.clone(),
            length,
        })
        .await;
        let refused = fetch(&format!("{base}/a.png")).await;
        assert!(
            matches!(refused, Err(CustomIconError::TooLarge)),
            "length {length}: {refused:?}"
        );
    }
    let liar = serve(Reply::Claims {
        declared: 64 * 1024 * 1024,
    })
    .await;
    assert!(matches!(
        fetch(&format!("{liar}/a.png")).await,
        Err(CustomIconError::TooLarge)
    ));

    // Exactly the cap is read whole.
    let at = serve(Reply::Body {
        status: 200,
        content_type: Some("image/png"),
        body: vec![7u8; MAX_INPUT_BYTES],
        length: false,
    })
    .await;
    assert_eq!(
        fetch(&format!("{at}/a.png")).await.unwrap().bytes.len(),
        MAX_INPUT_BYTES
    );
}

#[tokio::test]
async fn a_host_that_stalls_times_out() {
    let timeout = Duration::from_millis(300);
    for headers in [false, true] {
        let base = serve(Reply::Stall { headers }).await;
        let started = Instant::now();
        let outcome = download_within(&client(), &format!("{base}/a.png"), timeout).await;
        assert!(
            matches!(outcome, Err(CustomIconError::Download { timed_out: true })),
            "headers {headers}: {outcome:?}"
        );
        assert!(started.elapsed() >= timeout);
    }
}

#[tokio::test]
async fn a_link_that_is_not_an_image_is_refused() {
    let page = serve(ok(Some("text/html"), b"<html>sign in</html>".to_vec())).await;
    let refused = fetch(&format!("{page}/logo.png")).await;
    assert!(
        matches!(refused, Err(CustomIconError::UnsupportedUrl)),
        "{refused:?}"
    );

    let missing = serve(Reply::Body {
        status: 404,
        content_type: Some("image/png"),
        body: b"gone".to_vec(),
        length: true,
    })
    .await;
    let refused = fetch(&format!("{missing}/logo.png")).await;
    assert!(
        matches!(refused, Err(CustomIconError::Download { timed_out: false })),
        "{refused:?}"
    );

    let empty = serve(ok(Some("image/png"), Vec::new())).await;
    assert!(matches!(
        fetch(&format!("{empty}/a.png")).await,
        Err(CustomIconError::Download { .. })
    ));

    for link in [
        "file:///etc/passwd",
        "ftp://example.com/a.png",
        "not a link",
        "",
    ] {
        assert!(
            matches!(fetch(link).await, Err(CustomIconError::InvalidUrl)),
            "{link}"
        );
    }
}
