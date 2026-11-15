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
