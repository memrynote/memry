//! `ImageService` against Electron's image-processing operations (`operations.ts`), through real
//! files in a temp dir. The expected sizes were measured on Electron's sharp 0.35.4 (libvips
//! 8.18.6) with the options `operations.ts` passes.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use image::{ImageFormat, ImageReader, Rgba, RgbaImage};
use memry_desktop::services::image_processing::{ImageError, ImageService};

/// `(width, height, thumbnail size, inbox thumbnail size)` from sharp's `resize(200 | 400, ...,
/// { fit: 'inside', withoutEnlargement: true })`.
type Size = (u32, u32);

const SHARP_SIZES: [(u32, u32, Size, Size); 9] = [
    (600, 399, (200, 133), (400, 266)),
    (399, 600, (133, 200), (266, 400)),
    (401, 199, (200, 99), (400, 199)),
    (333, 201, (200, 121), (333, 201)),
    (201, 333, (121, 200), (201, 333)),
    (150, 90, (150, 90), (150, 90)),
    (1000, 1, (200, 1), (400, 1)),
    (1, 1000, (1, 200), (1, 400)),
    (999, 1001, (200, 200), (399, 400)),
];

fn service() -> ImageService {
    ImageService::with_ffmpeg_dirs(Vec::new(), Duration::from_secs(10))
}

fn png(image: &RgbaImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .expect("png");
    bytes
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).expect("write");
    path
}

fn read_as(bytes: &[u8], format: ImageFormat) -> RgbaImage {
    ImageReader::with_format(Cursor::new(bytes), format)
        .decode()
        .unwrap_or_else(|error| panic!("not {format:?}: {error}"))
        .into_rgba8()
}

/// A case of `pixel-tensors.json`, the vectors of the shared decode.
fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/pixel-tensors.json");
    let file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).expect("vectors")).expect("json");
    let case = file["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("no case {name}"))
        .clone();
    base64::engine::general_purpose::STANDARD
        .decode(case["input"].as_str().expect("input"))
        .expect("base64")
}

/// Noise defeats PNG compression: 1024x1024 of it is well past the 1 MiB PNG limit.
fn noise(width: u32, height: u32) -> RgbaImage {
    let mut state = 0x2545_F491_u32;
    RgbaImage::from_fn(width, height, |_, _| {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        let [r, g, b, _] = state.to_le_bytes();
        Rgba([r, g, b, 255])
    })
}

#[tokio::test]
async fn image_thumbnails_are_webp_at_sharps_sizes() {
    let dir = tempfile::tempdir().expect("dir");
    let service = service();
    for (width, height, expected, _) in SHARP_SIZES {
        let image = RgbaImage::from_pixel(width, height, Rgba([128, 128, 128, 255]));
        let path = write(dir.path(), &format!("{width}x{height}.png"), &png(&image));
        let thumbnail = service
            .generate_thumbnail(path, "image/png")
            .await
            .expect("ran")
            .expect("thumbnail");
        let decoded = read_as(&thumbnail.data, ImageFormat::WebP);
        assert_eq!(decoded.dimensions(), expected, "{width}x{height}");
        assert_eq!((thumbnail.width, thumbnail.height), expected);
    }
}

#[tokio::test]
async fn a_pdf_gets_electrons_160_by_200_badge_and_other_types_get_none() {
    let dir = tempfile::tempdir().expect("dir");
    let service = service();
    let pdf = write(dir.path(), "a.pdf", b"%PDF-1.7");
    let badge = service
        .generate_thumbnail(pdf.clone(), "application/pdf")
        .await
        .expect("ran")
        .expect("badge");
    let decoded = read_as(&badge.data, ImageFormat::WebP);
    assert_eq!(decoded.dimensions(), (160, 200));
    // `#DC2626`, the badge's fill, away from the text and the rounded corners (lossy WebP).
    let corner = decoded.get_pixel(20, 20).0;
    assert!(
        corner[0] > 200 && corner[1] < 70 && corner[2] < 70,
        "{corner:?}"
    );

    let svg = write(
        dir.path(),
        "a.svg",
        b"<svg xmlns='http://www.w3.org/2000/svg'/>",
    );
    for (path, mime) in [(svg, "image/svg+xml"), (pdf, "text/plain")] {
        assert!(
            service
                .generate_thumbnail(path, mime)
                .await
                .expect("ran")
                .is_none(),
            "{mime}"
        );
    }
}

#[tokio::test]
async fn an_unreadable_image_gets_no_thumbnail() {
    let dir = tempfile::tempdir().expect("dir");
    let broken = write(dir.path(), "broken.png", b"\x89PNG\r\n\x1a\nnot really");
    let missing = dir.path().join("missing.png");
    for path in [broken, missing] {
        let outcome = service().generate_thumbnail(path, "image/png").await;
        assert!(outcome.expect("ran").is_none());
    }
}

#[tokio::test]
async fn a_thumbnail_keeps_alpha() {
    let dir = tempfile::tempdir().expect("dir");
    let image = RgbaImage::from_fn(300, 300, |x, _| {
        Rgba([200, 30, 30, if x < 150 { 0 } else { 255 }])
    });
    let path = write(dir.path(), "alpha.png", &png(&image));
    let thumbnail = service()
        .generate_thumbnail(path, "image/png")
        .await
        .expect("ran")
        .expect("thumbnail");
    let decoded = read_as(&thumbnail.data, ImageFormat::WebP);
    assert_eq!(decoded.get_pixel(10, 100)[3], 0);
    assert_eq!(decoded.get_pixel(190, 100)[3], 255);
}

/// The first frame, as sharp reads an animated image: the thumbnail's mean colour is the first
/// frame's, not the second's.
#[tokio::test]
async fn an_animated_webp_thumbnails_its_first_frame() {
    use image::AnimationDecoder as _;

    let bytes = fixture("webp animated @140");
    let frames: Vec<RgbaImage> = image::codecs::webp::WebPDecoder::new(Cursor::new(&bytes))
        .expect("webp")
        .into_frames()
        .take(2)
        .map(|frame| frame.expect("frame").into_buffer())
        .collect();
    let mean = |image: &RgbaImage| {
        let mut sum = [0_u64; 3];
        for pixel in image.pixels() {
            for (total, value) in sum.iter_mut().zip(pixel.0) {
                *total += u64::from(value);
            }
        }
        sum.map(|total| total / u64::from(image.width() * image.height()))
    };
    let (first, second) = (mean(&frames[0]), mean(&frames[1]));
    assert_ne!(first, second, "the fixture's frames differ");

    let dir = tempfile::tempdir().expect("dir");
    let path = write(dir.path(), "animated.webp", &bytes);
    let thumbnail = service()
        .generate_thumbnail(path, "image/webp")
        .await
        .expect("ran")
        .expect("thumbnail");
    let got = mean(&read_as(&thumbnail.data, ImageFormat::WebP));
    let distance =
        |a: [u64; 3], b: [u64; 3]| a.iter().zip(b).map(|(x, y)| x.abs_diff(y)).sum::<u64>();
    assert!(distance(got, first) <= 3, "{got:?} vs first {first:?}");
    assert!(distance(got, second) > 3, "{got:?} vs second {second:?}");
}

/// Only one byte past the 30 MiB cap is read: the decode reports that size, not the file's.
#[tokio::test]
async fn an_image_over_30_mib_is_read_only_to_the_cap() {
    let dir = tempfile::tempdir().expect("dir");
    let mut bytes = png(&noise(4, 4));
    bytes.resize(30 * 1024 * 1024 + 4096, 0);
    let path = write(dir.path(), "big.png", &bytes);
    let error = service().inbox_image(path).await.expect_err("refused");
    assert_eq!(
        error.to_string(),
        "image is 31457281 bytes, over the 31457280-byte limit"
    );
}

/// A FIFO named like an image is refused before a read, which would block until a writer came and
/// hold a worker until then.
#[cfg(unix)]
#[tokio::test]
async fn a_fifo_is_refused_without_blocking() {
    use std::os::unix::ffi::OsStrExt as _;

    let dir = tempfile::tempdir().expect("dir");
    let fifo = dir.path().join("a.png");
    let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).expect("path");
    // SAFETY: `name` is a NUL-terminated path that outlives the call.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0, "mkfifo");
    let service = service();
    let error = service
        .inbox_image(fifo.clone())
        .await
        .expect_err("refused");
    assert!(
        matches!(&error, ImageError::Read(io) if io.kind() == std::io::ErrorKind::InvalidInput),
        "{error:?}"
    );
    let thumbnail = service.generate_thumbnail(fifo, "image/png").await;
    assert!(thumbnail.expect("ran").is_none());
}

#[tokio::test]
async fn inbox_images_report_sharps_metadata_and_a_400_px_jpeg() {
    let dir = tempfile::tempdir().expect("dir");
    let service = service();
    for (width, height, _, expected) in SHARP_SIZES {
        let image = RgbaImage::from_pixel(width, height, Rgba([128, 128, 128, 255]));
        let path = write(dir.path(), &format!("{width}x{height}.png"), &png(&image));
        let inbox = service.inbox_image(path).await.expect("inbox");
        assert_eq!(
            (inbox.format, inbox.width, inbox.height),
            ("png", width, height)
        );
        assert!(!inbox.has_exif);
        let jpeg = read_as(&inbox.thumbnail_jpeg.expect("jpeg"), ImageFormat::Jpeg);
        assert_eq!(jpeg.dimensions(), expected, "{width}x{height}");
    }

    // The stored size, as sharp's `metadata()` reports it, and EXIF counts.
    let rotated = write(
        dir.path(),
        "rotated.jpg",
        &fixture("jpeg orientation 6 @140"),
    );
    let inbox = service.inbox_image(rotated).await.expect("inbox");
    let stored = image::load_from_memory(&fixture("jpeg orientation 6 @140")).expect("jpeg");
    assert_eq!(
        (inbox.format, inbox.width, inbox.height),
        ("jpeg", stored.width(), stored.height())
    );
    assert!(inbox.has_exif);
    let profiled = write(dir.path(), "p3.png", &fixture("png p3 profile @140"));
    assert!(
        service.inbox_image(profiled).await.expect("inbox").has_exif,
        "a profile counts"
    );
}

#[tokio::test]
async fn view_images_are_upright_png_under_1_mib_and_jpeg_on_white_above() {
    let service = service();
    let small = service
        .prepare_view_image(png(&noise(120, 80)), 100)
        .await
        .expect("view");
    assert_eq!(small.mime_type, "image/png");
    assert_eq!(
        read_as(&small.data, ImageFormat::Png).dimensions(),
        (100, 67)
    );
    assert_eq!((small.width, small.height), (100, 67));
    assert_eq!((small.source_width, small.source_height), (120, 80));

    let mut large = noise(1024, 1024);
    for x in 0..1024 {
        large.put_pixel(x, 0, Rgba([0, 0, 0, 0]));
        large.put_pixel(x, 1, Rgba([0, 0, 0, 0]));
    }
    let view = service
        .prepare_view_image(png(&large), 2048)
        .await
        .expect("view");
    assert_eq!(view.mime_type, "image/jpeg");
    let jpeg = read_as(&view.data, ImageFormat::Jpeg);
    assert_eq!(jpeg.dimensions(), (1024, 1024));
    let top = jpeg.get_pixel(512, 0).0;
    assert!(
        top[..3].iter().all(|&sample| sample > 200),
        "flattened on white: {top:?}"
    );

    // Orientation 6: the output and the source size are the upright ones.
    let bytes = fixture("jpeg orientation 6 @140");
    let stored = image::load_from_memory(&bytes).expect("jpeg");
    let upright = service.prepare_view_image(bytes, 4096).await.expect("view");
    assert_eq!(
        (upright.source_width, upright.source_height),
        (stored.height(), stored.width())
    );
    assert_eq!(
        (upright.width, upright.height),
        (stored.height(), stored.width())
    );

    assert!(
        service
            .prepare_view_image(b"text".to_vec(), 100)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_video_gets_no_thumbnail_without_ffmpeg() {
    let dir = tempfile::tempdir().expect("dir");
    let video = write(dir.path(), "clip.mp4", b"not a video");
    let outcome = service().generate_thumbnail(video, "video/mp4").await;
    assert!(outcome.expect("ran").is_none());
}

/// Needs a real ffmpeg on `PATH` (`brew install ffmpeg`); CI images have none.
#[tokio::test]
#[ignore = "needs ffmpeg"]
async fn a_real_ffmpeg_gives_a_webp_frame_at_most_200_px() {
    let dir = tempfile::tempdir().expect("dir");
    let ffmpeg_dir = std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
        .find(|dir| dir.join("ffmpeg").is_file())
        .expect("ffmpeg on PATH");
    let video = dir.path().join("clip -y.mp4");
    let made = std::process::Command::new(ffmpeg_dir.join("ffmpeg"))
        .args(["-loglevel", "error", "-f", "lavfi", "-i"])
        .arg("testsrc=duration=2:size=640x360:rate=10")
        .args(["-pix_fmt", "yuv420p"])
        .arg(&video)
        .status()
        .expect("ffmpeg");
    assert!(made.success());
    let service = ImageService::with_ffmpeg_dirs(vec![ffmpeg_dir], Duration::from_secs(10));
    let thumbnail = service
        .generate_thumbnail(video, "video/mp4")
        .await
        .expect("ran")
        .expect("frame");
    let decoded = read_as(&thumbnail.data, ImageFormat::WebP);
    assert_eq!(decoded.dimensions(), (200, 113));
}

/// A stand-in ffmpeg: a shell script in a temp dir, so the command line and the time limit are
/// tested without a real one.
#[cfg(unix)]
mod fake_ffmpeg {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    fn install(dir: &Path, body: &str) -> PathBuf {
        let bin = dir.join("bin");
        std::fs::create_dir(&bin).expect("bin");
        let script = bin.join("ffmpeg");
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).expect("script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        bin
    }

    #[tokio::test]
    async fn the_path_reaches_ffmpeg_as_one_file_argument_and_no_shell_runs_it() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path().canonicalize().expect("root");
        let frame = write(&root, "frame.png", &png(&noise(160, 90)));
        let args = root.join("args");
        let bin = install(
            &root,
            &format!(
                "printf '%s\\n' \"$@\" > '{}'\ncat '{}'",
                args.display(),
                frame.display()
            ),
        );
        let name = "-y; $(touch pwned) `touch pwned` 'q' http:x.mp4";
        let video = write(&root, name, b"video");
        let service = ImageService::with_ffmpeg_dirs(vec![bin], Duration::from_secs(10));
        let thumbnail = service
            .generate_thumbnail(video.clone(), "video/webm")
            .await
            .expect("ran")
            .expect("frame");
        // ffmpeg scaled the frame already; the WebP keeps its size.
        assert_eq!(
            read_as(&thumbnail.data, ImageFormat::WebP).dimensions(),
            (160, 90)
        );

        let received = std::fs::read_to_string(&args).expect("args");
        let input = format!("file:{}", video.display());
        let expected = [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm",
            "-i",
            &input,
            "-ss",
            "1",
            "-vframes",
            "1",
            "-vf",
            "scale=200:200:force_original_aspect_ratio=decrease",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "-",
        ];
        assert_eq!(received.lines().collect::<Vec<_>>(), expected);
        assert!(!root.join("pwned").exists());
        assert!(!std::env::current_dir().expect("cwd").join("pwned").exists());
    }

    #[tokio::test]
    async fn ffmpeg_past_its_time_limit_is_killed() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path().canonicalize().expect("root");
        let pid_file = root.join("pid");
        // `exec` keeps the pid, so the process the service spawned is the one that sleeps.
        let bin = install(
            &root,
            &format!("echo $$ > '{}'\nexec sleep 600", pid_file.display()),
        );
        let video = write(&root, "clip.mp4", b"video");
        let service = ImageService::with_ffmpeg_dirs(vec![bin], Duration::from_secs(2));
        let outcome = service.generate_thumbnail(video, "video/mp4").await;
        assert!(outcome.expect("ran").is_none());

        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .expect("the script started")
            .trim()
            .parse()
            .expect("pid");
        // SAFETY: signal 0 only checks that the process exists; it sends nothing.
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        assert!(!alive, "ffmpeg {pid} still runs");
    }

    /// More output than a frame can hold ends the run at once, without waiting for the time limit.
    #[tokio::test]
    async fn ffmpeg_printing_more_than_a_frame_is_killed() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path().canonicalize().expect("root");
        let pid_file = root.join("pid");
        let bin = install(
            &root,
            &format!(
                "echo $$ > '{}'\nhead -c 17000000 /dev/zero\nexec sleep 600",
                pid_file.display()
            ),
        );
        let video = write(&root, "clip.mp4", b"video");
        // A limit past the pool's 60 s: only the output cap can end this run in time.
        let service = ImageService::with_ffmpeg_dirs(vec![bin], Duration::from_secs(600));
        let outcome = service.generate_thumbnail(video, "video/mp4").await;
        assert!(outcome.expect("ran").is_none());

        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .expect("the script started")
            .trim()
            .parse()
            .expect("pid");
        // SAFETY: signal 0 only checks that the process exists; it sends nothing.
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        assert!(!alive, "ffmpeg {pid} still runs");
    }

    /// A non-executable `ffmpeg` earlier on `PATH` is skipped, as `which` skips it.
    #[tokio::test]
    async fn a_non_executable_ffmpeg_is_skipped() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path().canonicalize().expect("root");
        let frame = write(&root, "frame.png", &png(&noise(32, 18)));
        let shadow = root.join("shadow");
        std::fs::create_dir(&shadow).expect("shadow");
        std::fs::write(shadow.join("ffmpeg"), "#!/bin/sh\nexit 1\n").expect("shadow ffmpeg");
        let bin = install(&root, &format!("cat '{}'", frame.display()));
        let video = write(&root, "clip.mp4", b"video");
        let service = ImageService::with_ffmpeg_dirs(vec![shadow, bin], Duration::from_secs(10));
        let thumbnail = service
            .generate_thumbnail(video, "video/mp4")
            .await
            .expect("ran")
            .expect("the executable one ran");
        assert_eq!((thumbnail.width, thumbnail.height), (32, 18));
    }

    #[tokio::test]
    async fn a_failing_ffmpeg_gives_no_thumbnail() {
        let dir = tempfile::tempdir().expect("dir");
        let bin = install(dir.path(), "echo partial; exit 1");
        let video = write(dir.path(), "clip.mp4", b"video");
        let service = ImageService::with_ffmpeg_dirs(vec![bin], Duration::from_secs(10));
        let outcome = service.generate_thumbnail(video, "video/mp4").await;
        assert!(outcome.expect("ran").is_none());
    }
}
