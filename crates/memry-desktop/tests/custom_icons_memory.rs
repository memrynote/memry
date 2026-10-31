//! Normalizing an icon holds a bounded amount of memory whatever its header claims. A JPEG or WebP
//! decoder sizes its buffers from the header, and `image`'s `max_alloc` covers only the output
//! buffer, not zune-jpeg's progressive coefficients or image-webp's frame. So a few hundred bytes
//! whose output fits the allocation cap still take hundreds of MB before failing on the missing
//! data, unless the pixel count is refused from the header first.
//!
//! The counting allocator sees the whole process, so this binary holds this one test.

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};

use image::{DynamicImage, GrayImage, ImageFormat};
use memry_desktop::notes::icons::{CustomIconError, MAX_PIXELS, normalize};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grew(by: usize) {
    let live = LIVE.fetch_add(by, Ordering::Relaxed) + by;
    PEAK.fetch_max(live, Ordering::Relaxed);
}

// SAFETY: every call goes to the system allocator unchanged; this only counts sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller's contract for `alloc`, passed on.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            grew(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller's contract for `alloc_zeroed`, passed on.
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            grew(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: the caller's contract for `dealloc`, passed on.
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: the caller's contract for `realloc`, passed on.
        let moved = unsafe { System.realloc(ptr, layout, new_size) };
        if !moved.is_null() {
            // Both blocks may be live while the bytes move.
            grew(new_size);
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Bytes allocated at the peak of `work`, over what was live before it.
fn peak_of<T>(work: impl FnOnce() -> T) -> (usize, T) {
    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let out = work();
    (PEAK.load(Ordering::Relaxed) - before, out)
}

/// A greyscale baseline 16 x 16 JPEG from the encoder, its frame turned progressive (SOF2) and
/// declaring `side` x `side`, its first scan a DC scan. The scan data is too short for that size.
fn progressive_jpeg(side: u16) -> Vec<u8> {
    let small = DynamicImage::ImageLuma8(GrayImage::from_pixel(16, 16, image::Luma([200])));
    let mut jpeg = Vec::new();
    small
        .write_to(&mut Cursor::new(&mut jpeg), ImageFormat::Jpeg)
        .expect("encode");
    let sof = jpeg
        .windows(2)
        .position(|w| w == [0xFF, 0xC0])
        .expect("a baseline frame");
    jpeg[sof + 1] = 0xC2;
    // FF C2, length (2), precision (1), height (2), width (2).
    jpeg[sof + 5..sof + 7].copy_from_slice(&side.to_be_bytes());
    jpeg[sof + 7..sof + 9].copy_from_slice(&side.to_be_bytes());
    let sos = jpeg
        .windows(2)
        .rposition(|w| w == [0xFF, 0xDA])
        .expect("a scan");
    // FF DA, length (2), component count n, n x 2 bytes, then Ss, Se, AhAl.
    let n = usize::from(jpeg[sos + 4]);
    let spectral = sos + 5 + 2 * n;
    jpeg[spectral] = 0; // Ss
    jpeg[spectral + 1] = 0; // Se: a DC scan
    jpeg[spectral + 2] = 0; // Ah, Al
    jpeg
}

/// A lossless WebP (VP8L) whose header declares `side` x `side`, with a few bytes of data.
fn large_webp(side: u32) -> Vec<u8> {
    let size = (side - 1) & 0x3FFF;
    let bits: u32 = size | (size << 14); // no alpha hint, version 0
    let mut chunk = vec![0x2F];
    chunk.extend_from_slice(&bits.to_le_bytes());
    chunk.extend_from_slice(&[0u8; 16]);
    let mut webp = b"RIFF".to_vec();
    webp.extend_from_slice(&((4 + 8 + chunk.len()) as u32).to_le_bytes());
    webp.extend_from_slice(b"WEBP");
    webp.extend_from_slice(b"VP8L");
    webp.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
    webp.extend_from_slice(&chunk);
    webp
}

/// Far below any decoder buffer for the declared sizes.
const BOUND: usize = 16 * 1024 * 1024;

#[test]
fn an_image_that_declares_too_many_pixels_is_refused_before_it_is_decoded() {
    const { assert!(11_500 * 11_500 > MAX_PIXELS && 6_500 * 6_500 > MAX_PIXELS) };
    for (what, bytes) in [
        // 132 M grey pixels: a 126 MiB output fits a 128 MiB `max_alloc`, the progressive
        // coefficients (two bytes a pixel) do not count against it.
        ("progressive jpeg", progressive_jpeg(11_500)),
        // 42 M pixels: a 127 MB RGB output fits `max_alloc`; the decoder's RGBA frame does not
        // count against it.
        ("webp", large_webp(6_500)),
    ] {
        assert_eq!(
            image::guess_format(&bytes).ok(),
            Some(if what == "webp" {
                ImageFormat::WebP
            } else {
                ImageFormat::Jpeg
            })
        );
        let (peak, outcome) = peak_of(|| normalize(&bytes, "png"));
        assert!(
            matches!(outcome, Err(CustomIconError::Unreadable)),
            "{what}: {:?}",
            outcome.map(|icon| icon.bytes.len())
        );
        assert!(peak <= BOUND, "{what}: {peak} bytes at the peak");
    }
}
