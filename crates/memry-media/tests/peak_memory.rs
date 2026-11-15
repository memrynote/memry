//! What a decode holds at its peak, measured by an allocator that counts the calling thread's
//! live bytes (the decoders run on the caller's thread). The inputs are the smallest files that
//! reach the largest frames the decode accepts: zeros compress to almost nothing.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use memry_media::decode_fit;

/// `memry_media`'s `MAX_DECODE_ALLOC`.
const CAP: i64 = 512 * 1024 * 1024;

struct Counting;

thread_local! {
    static LIVE: Cell<i64> = const { Cell::new(0) };
    static PEAK: Cell<i64> = const { Cell::new(0) };
}

fn add(bytes: i64) {
    // `try_with` because the allocator also runs while thread-locals are torn down.
    let _ = LIVE.try_with(|live| {
        let now = live.get() + bytes;
        live.set(now);
        let _ = PEAK.try_with(|peak| peak.set(peak.get().max(now)));
    });
}

// SAFETY: forwards every call to `System` unchanged and only counts sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        add(layout.size() as i64);
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        add(layout.size() as i64);
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        add(-(layout.size() as i64));
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // A move holds both buffers for a moment; count the larger sum.
        add(new_size as i64);
        let moved = unsafe { System.realloc(ptr, layout, new_size) };
        add(-(layout.size() as i64));
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// The most bytes `run` held at once beyond what was live before it.
fn peak_of<T>(run: impl FnOnce() -> T) -> (T, i64) {
    let before = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(before));
    let value = run();
    (value, PEAK.with(Cell::get) - before)
}

/// A PNG of zeros, 8 bits per sample, `color` 0 (grey) or 2 (RGB), with an `iCCP` chunk when
/// `profile` is given. Streams the rows through the compressor without holding the image.
fn zeros_png(width: u32, height: u32, color: u8, profile: Option<&[u8]>) -> Vec<u8> {
    let channels = if color == 2 { 3 } else { 1 };
    let mut ihdr = Vec::new();
    ihdr.extend(width.to_be_bytes());
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([8, color, 0, 0, 0]);
    let mut compressor = fdeflate::Compressor::new(Vec::new()).expect("compressor");
    let row = vec![0_u8; 1 + width as usize * channels];
    for _ in 0..height {
        compressor.write_data(&row).expect("row");
    }
    let idat = compressor.finish().expect("idat");
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend(chunk(b"IHDR", &ihdr));
    if let Some(profile) = profile {
        let mut iccp = b"icc\0\0".to_vec();
        iccp.extend(fdeflate::compress_to_vec(profile));
        png.extend(chunk(b"iCCP", &iccp));
    }
    png.extend(chunk(b"IDAT", &idat));
    png.extend(chunk(b"IEND", &[]));
    png
}

fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let body = [kind.as_slice(), data].concat();
    let mut out = u32::try_from(data.len())
        .expect("small")
        .to_be_bytes()
        .to_vec();
    out.extend(&body);
    let mut crc = !0_u32;
    for &byte in &body {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
        }
    }
    out.extend((!crc).to_be_bytes());
    out
}

fn srgb_profile() -> Vec<u8> {
    moxcms::ColorProfile::new_srgb()
        .encode()
        .expect("srgb profile")
}

/// Grey at sharp's pixel limit: a 268 MB frame, which a 4-channel copy would quadruple.
#[test]
fn a_grey_image_at_the_pixel_limit_thumbnails_under_the_cap() {
    let bytes = zeros_png(0x3FFF, 0x3FFF, 0, None);
    let (fitted, peak) = peak_of(|| decode_fit(&bytes, 200));
    let fitted = fitted.expect("decodes");
    assert_eq!((fitted.image.width(), fitted.image.height()), (200, 200));
    assert!(peak < CAP, "peak {peak} bytes");
}

/// 13000 x 13000 RGB with a profile: a 507 MB frame, which a full-size colour conversion would
/// double.
#[test]
fn an_rgb_image_with_a_profile_thumbnails_under_the_cap() {
    let bytes = zeros_png(13_000, 13_000, 2, Some(&srgb_profile()));
    let (fitted, peak) = peak_of(|| decode_fit(&bytes, 200));
    let fitted = fitted.expect("decodes");
    assert!(fitted.info.has_icc);
    assert_eq!((fitted.image.width(), fitted.image.height()), (200, 200));
    assert!(peak < CAP, "peak {peak} bytes");
}

/// The same grey image kept at full size needs its 3-channel copy beside the frame, past the cap:
/// refused from the header, before the frame is allocated.
#[test]
fn a_grey_image_too_large_to_convert_whole_is_refused_before_allocating() {
    let bytes = zeros_png(0x3FFF, 0x3FFF, 0, None);
    let (fitted, peak) = peak_of(|| decode_fit(&bytes, 0x3FFF));
    let error = fitted.expect_err("refused").to_string();
    assert!(error.ends_with("-byte limit"), "{error}");
    assert!(peak < 16 * 1024 * 1024, "peak {peak} bytes");

    let (rgb, peak) = peak_of(|| memry_media::decode(&bytes));
    assert!(
        rgb.expect_err("refused")
            .to_string()
            .ends_with("-byte limit")
    );
    assert!(peak < 16 * 1024 * 1024, "peak {peak} bytes");
}

/// A RIFF WebP of `chunks`, each a fourcc and its data.
fn webp(chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
    let mut body = b"WEBP".to_vec();
    for (fourcc, data) in chunks {
        body.extend(fourcc.as_slice());
        body.extend(u32::try_from(data.len()).expect("small").to_le_bytes());
        body.extend(data);
        if data.len() % 2 == 1 {
            body.push(0);
        }
    }
    let mut out = b"RIFF".to_vec();
    out.extend(u32::try_from(body.len()).expect("small").to_le_bytes());
    out.extend(body);
    out
}

/// A VP8L bitstream of transparent black: no transforms, and five Huffman codes of one symbol
/// each, so every pixel takes no bits.
fn vp8l(width: u32, height: u32, alpha: bool) -> Vec<u8> {
    let mut bits = 0_u64;
    let mut at = 0;
    let mut push = |value: u32, count: u32| {
        bits |= u64::from(value) << at;
        at += count;
    };
    push(0x2F, 8);
    push(width - 1, 14);
    push(height - 1, 14);
    push(u32::from(alpha), 1);
    push(0, 3); // version
    push(0, 3); // no transform, no colour cache, no meta Huffman codes
    for _ in 0..5 {
        push(0b0001, 4); // simple code, one symbol, 1-bit symbol 0
    }
    bits.to_le_bytes().to_vec()
}

fn three_bytes(value: u32) -> [u8; 3] {
    let [a, b, c, _] = value.to_le_bytes();
    [a, b, c]
}

/// An animated WebP without alpha whose one frame, lossless, fills the canvas.
fn animated_webp(width: u32, height: u32) -> Vec<u8> {
    let mut vp8x = vec![0x02, 0, 0, 0];
    vp8x.extend(three_bytes(width - 1));
    vp8x.extend(three_bytes(height - 1));
    let mut anmf = [0, 0, 0, 0, 0, 0].to_vec();
    anmf.extend(three_bytes(width - 1));
    anmf.extend(three_bytes(height - 1));
    anmf.extend(three_bytes(100));
    anmf.push(0);
    let frame = vp8l(width, height, false);
    anmf.extend(b"VP8L");
    anmf.extend(u32::try_from(frame.len()).expect("small").to_le_bytes());
    anmf.extend(frame);
    webp(&[(b"VP8X", vp8x), (b"ANIM", vec![0; 6]), (b"ANMF", anmf)])
}

/// A GIF whose first frame starts one pixel in from the left, so the decoder reads it into a
/// buffer of its own. Its LZW data ends at once, so a decode that gets that far fails.
fn offset_gif(width: u16, height: u16) -> Vec<u8> {
    let mut gif = b"GIF89a".to_vec();
    gif.extend(width.to_le_bytes());
    gif.extend(height.to_le_bytes());
    gif.extend([0x80, 0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF]);
    gif.push(0x2C);
    for value in [1, 0, width - 1, height] {
        gif.extend(value.to_le_bytes());
    }
    gif.extend([0, 2, 1, 0x2C, 0, 0x3B]);
    gif
}

fn assert_refused_before_allocating(bytes: &[u8]) {
    let (fitted, peak) = peak_of(|| decode_fit(bytes, 200));
    let error = fitted.expect_err("refused").to_string();
    assert!(error.ends_with("-byte limit"), "{error}");
    assert!(peak < 16 * 1024 * 1024, "peak {peak} bytes");

    let (rgb, peak) = peak_of(|| memry_media::decode(bytes));
    let error = rgb.expect_err("refused").to_string();
    assert!(error.ends_with("-byte limit"), "{error}");
    assert!(peak < 16 * 1024 * 1024, "peak {peak} bytes");
}

/// Its 536 MB RGB frame fits the cap, but the decoder also holds the first frame as RGBA and an
/// RGBA canvas: 1.96 GB.
#[test]
fn an_animated_opaque_webp_at_the_cap_is_refused_before_allocating() {
    assert_refused_before_allocating(&animated_webp(16_384, 10_900));
}

/// Its 536 MB RGB frame fits the cap, but the decoder decodes it as RGBA first: 1.25 GB.
#[test]
fn a_lossless_opaque_webp_at_the_cap_is_refused_before_allocating() {
    let bytes = webp(&[(b"VP8L", vp8l(16_383, 10_900, false))]);
    assert_refused_before_allocating(&bytes);
}

/// Its 524 MB frame fits the cap, but the decoder reads the offset first frame into an RGBA buffer
/// and its palette indices beside it: 1.18 GB.
#[test]
fn an_offset_first_frame_gif_at_the_cap_is_refused_before_allocating() {
    assert_refused_before_allocating(&offset_gif(16_384, 8_000));
}

/// The largest WebPs the decoder's scratch lets through, decoded: the counted scratch is at least
/// what the decoder holds.
#[test]
fn webps_just_under_the_cap_with_their_scratch_decode_under_it() {
    for bytes in [
        webp(&[(b"VP8L", vp8l(8_192, 8_192, false))]),
        animated_webp(8_192, 5_900),
    ] {
        let (fitted, peak) = peak_of(|| decode_fit(&bytes, 200));
        let fitted = fitted.expect("decodes");
        assert_eq!(fitted.image.width(), 200);
        assert!(peak < CAP, "peak {peak} bytes");
    }
}
