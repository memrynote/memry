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
    assert!(peak < 16 * 1024 * 1024, "peak {peak} bytes");
    let error = fitted.expect_err("refused").to_string();
    assert!(error.ends_with("-byte limit"), "{error}");

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

/// A GIF whose first frame, `left` pixels in from the left, is `width` by `height` on a `screen`,
/// so the decoder reads it into a buffer of its own unless it fills the screen's rows. Its LZW data
/// ends at once, so a decode that gets that far fails.
fn first_frame_gif(screen: (u16, u16), left: u16, width: u16, height: u16) -> Vec<u8> {
    let mut gif = b"GIF89a".to_vec();
    gif.extend(screen.0.to_le_bytes());
    gif.extend(screen.1.to_le_bytes());
    gif.extend([0x80, 0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF]);
    gif.push(0x2C);
    for value in [left, 0, width, height] {
        gif.extend(value.to_le_bytes());
    }
    gif.extend([0, 2, 1, 0x2C, 0, 0x3B]);
    gif
}

/// A GIF whose first frame starts one pixel in from the left.
fn offset_gif(width: u16, height: u16) -> Vec<u8> {
    first_frame_gif((width, height), 1, width - 1, height)
}

fn assert_refused_before_allocating(bytes: &[u8]) {
    let (fitted, peak) = peak_of(|| decode_fit(bytes, 200));
    assert!(peak < 16 * 1024 * 1024, "peak {peak} bytes");
    let error = fitted.expect_err("refused").to_string();
    assert!(error.ends_with("-byte limit"), "{error}");

    let (rgb, peak) = peak_of(|| memry_media::decode(bytes));
    assert!(peak < 16 * 1024 * 1024, "peak {peak} bytes");
    let error = rgb.expect_err("refused").to_string();
    assert!(error.ends_with("-byte limit"), "{error}");
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

/// A VP8 key frame's header, `width` by `height`, with an empty first partition: the decoder
/// allocates its planes, then fails.
fn vp8(width: u16, height: u16) -> Vec<u8> {
    let mut data = vec![0, 0, 0, 0x9D, 0x01, 0x2A];
    data.extend(width.to_le_bytes());
    data.extend(height.to_le_bytes());
    data
}

/// A VP8X header: `flags`, then the canvas size.
fn vp8x(flags: u8, width: u32, height: u32) -> Vec<u8> {
    let mut data = vec![flags, 0, 0, 0];
    data.extend(three_bytes(width - 1));
    data.extend(three_bytes(height - 1));
    data
}

/// An ANMF chunk's data: a `width` by `height` frame at the origin, then `frame`.
fn anmf(width: u32, height: u32, frame: &[u8]) -> Vec<u8> {
    let mut data = [0, 0, 0, 0, 0, 0].to_vec();
    data.extend(three_bytes(width - 1));
    data.extend(three_bytes(height - 1));
    data.extend(three_bytes(100));
    data.push(0);
    data.extend(frame);
    data
}

fn subchunk(fourcc: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = fourcc.to_vec();
    out.extend(u32::try_from(data.len()).expect("small").to_le_bytes());
    out.extend(data);
    out
}

/// Refused before the frame or any scratch is allocated, with `reason`.
fn assert_refused_early(bytes: &[u8], reason: &str) {
    let (fitted, peak) = peak_of(|| decode_fit(bytes, 200));
    assert!(peak < 16 * 1024 * 1024, "peak {peak} bytes");
    let error = fitted.expect_err("refused").to_string();
    assert!(error.contains(reason), "{error}");

    let (rgb, peak) = peak_of(|| memry_media::decode(bytes));
    assert!(peak < 16 * 1024 * 1024, "peak {peak} bytes");
    let error = rgb.expect_err("refused").to_string();
    assert!(error.contains(reason), "{error}");
}

/// A still image whose decoder reads the lossless frame inside an ANMF chunk instead of the lossy
/// one beside it: counted as lossy (4.5 bytes a pixel, 533 MB), it decodes at 7.875 (932 MB).
#[test]
fn a_still_webp_holding_an_animation_frame_is_refused_before_allocating() {
    let lossless = subchunk(b"VP8L", &vp8l(10_880, 10_880, false));
    let bytes = webp(&[
        (b"VP8X", vp8x(0, 10_880, 10_880)),
        (b"VP8 ", vp8(10_880, 10_880)),
        (b"ANMF", anmf(10_880, 10_880, &lossless)),
    ]);
    assert_refused_early(&bytes, "animation frame");
}

/// The decoder sizes a VP8 frame's planes from its own header, before comparing it with the
/// image: a 16383 square header in a 10880 square still image, 758 MB.
#[test]
fn a_vp8_header_larger_than_its_still_image_is_refused_before_allocating() {
    let still = webp(&[
        (b"VP8X", vp8x(0, 10_880, 10_880)),
        (b"VP8 ", vp8(16_383, 16_383)),
    ]);
    assert_refused_early(&still, "VP8 frame size");
}

/// The same in a 6900 square animation frame, 545 MB.
#[test]
fn a_vp8_header_larger_than_its_animation_frame_is_refused_before_allocating() {
    let frame = subchunk(b"VP8 ", &vp8(16_383, 16_383));
    let animated = webp(&[
        (b"VP8X", vp8x(0x02, 6_900, 6_900)),
        (b"ANIM", vec![0; 6]),
        (b"ANMF", anmf(6_900, 6_900, &frame)),
    ]);
    assert_refused_early(&animated, "VP8 frame size");
}

/// `webp` with a last chunk whose header declares 4 GiB and whose data stops after 4 bytes.
fn with_cut_chunk(mut file: Vec<u8>, fourcc: &[u8; 4]) -> Vec<u8> {
    file.extend(fourcc);
    file.extend(0xFFFF_FFF0_u32.to_le_bytes());
    file.extend([0; 4]);
    let riff = u32::try_from(file.len() - 8).expect("small");
    file[4..8].copy_from_slice(&riff.to_le_bytes());
    file
}

/// The decoder allocates an EXIF chunk at its declared size before reading it: 4 GiB from a
/// 58-byte file.
#[test]
fn a_webp_chunk_past_the_end_of_the_file_is_refused_before_allocating() {
    let still = with_cut_chunk(
        webp(&[(b"VP8X", vp8x(0x08, 1, 1)), (b"VP8L", vp8l(1, 1, false))]),
        b"EXIF",
    );
    assert_refused_early(&still, "past the end of the file");
}

/// The same as an animation frame's subchunk, which the decoder files as the image's EXIF.
#[test]
fn a_webp_frame_subchunk_past_the_end_of_the_file_is_refused_before_allocating() {
    let mut cut = b"EXIF".to_vec();
    cut.extend(0xFFFF_FFF0_u32.to_le_bytes());
    cut.extend([0; 4]);
    let animated = webp(&[
        (b"VP8X", vp8x(0x02, 1, 1)),
        (b"ANIM", vec![0; 6]),
        (b"ANMF", anmf(1, 1, &cut)),
    ]);
    assert_refused_early(&animated, "past the end of the file");
}

/// cwebp's default for an image with alpha: a lossy frame and a lossless-coded alpha plane, which
/// the decoder decodes to RGBA beside a copy: 11.375 bytes a pixel, 557 MB at 7000 square.
#[test]
fn a_lossy_webp_with_lossless_alpha_at_the_cap_is_refused_before_allocating() {
    let bytes = webp(&[
        (b"VP8X", vp8x(0x10, 7_000, 7_000)),
        (b"ALPH", vec![0x01]),
        (b"VP8 ", vp8(7_000, 7_000)),
    ]);
    assert_refused_before_allocating(&bytes);
}

/// A first frame larger than a 16-pixel screen: the decoder reads it whole into its own RGBA
/// buffer beside its palette indices, 655 MB.
#[test]
fn a_gif_first_frame_larger_than_its_screen_is_refused_before_allocating() {
    assert_refused_before_allocating(&first_frame_gif((16, 16), 0, 16_384, 8_000));
}

/// Bits written least significant first, as VP8L reads them.
#[derive(Default)]
struct Bits {
    bytes: Vec<u8>,
    at: usize,
}

impl Bits {
    fn push(&mut self, value: u32, count: u32) {
        for bit in 0..count {
            if self.at.is_multiple_of(8) {
                self.bytes.push(0);
            }
            if value >> bit & 1 == 1 {
                *self.bytes.last_mut().expect("pushed") |= 1 << (self.at % 8);
            }
            self.at += 1;
        }
    }

    /// A Huffman code, its first bit the most significant.
    fn push_code(&mut self, code: u32, length: u32) {
        for bit in (0..length).rev() {
            self.push(code >> bit & 1, 1);
        }
    }
}

/// A 1 by 1 VP8L image whose entropy image names group 65535, so the decoder reads 65,536 groups
/// of five Huffman codes. Each code has lengths 1 to 10 and 10 again, about 12 bytes to describe,
/// and the decoder builds a 1024-entry table for it: 1.25 GiB of tables from 3.8 MB.
fn huffman_groups_vp8l(width: u32, height: u32, alpha: bool, groups: u32) -> Vec<u8> {
    let mut bits = Bits::default();
    bits.push(0x2F, 8);
    bits.push(width - 1, 14);
    bits.push(height - 1, 14);
    bits.push(u32::from(alpha), 1);
    bits.push(0, 3); // version
    bits.push(0, 1); // no transform
    bits.push(0, 1); // no colour cache
    bits.push(1, 1); // meta Huffman codes
    bits.push(0, 3); // 4 by 4 blocks
    // The entropy image: no colour cache, then one-symbol codes for green, red, blue, alpha and
    // distance 0, so every pixel names the last group and takes no bits.
    bits.push(0, 1);
    for symbol in [(groups - 1) & 0xFF, (groups - 1) >> 8] {
        bits.push(0b1, 1); // simple
        bits.push(0, 1); // one symbol
        bits.push(1, 1); // 8 bits
        bits.push(symbol, 8);
    }
    for _ in 0..3 {
        bits.push(0b0001, 4); // simple, one symbol, 1-bit symbol 0
    }
    // The code-length code: lengths 1 to 6 coded in 3 bits, 7 to 10 in 4 (a complete code), in
    // `CODE_LENGTH_CODE_ORDER` up to symbol 10, the 14th.
    let order = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10];
    let code_length = |symbol: u32| match symbol {
        1..=6 => 3,
        7..=10 => 4,
        _ => 0,
    };
    // Canonical codes: 1 to 6 are 0b000 to 0b101, 7 to 10 are 0b1100 to 0b1111.
    let code = |length: u32| {
        if length <= 6 {
            (length - 1, 3)
        } else {
            (0b1100 + length - 7, 4)
        }
    };
    let lengths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10];
    for _ in 0..groups * 5 {
        bits.push(0, 1); // normal code
        bits.push(order.len() as u32 - 4, 4);
        for symbol in order {
            bits.push(code_length(symbol), 3);
        }
        bits.push(1, 1); // the symbol count follows
        bits.push(1, 3); // in 4 bits
        bits.push(lengths.len() as u32 - 2, 4);
        for length in lengths {
            let (value, bits_long) = code(length);
            bits.push_code(value, bits_long);
        }
    }
    bits.bytes
}

/// image-webp builds every group's tables, used or not, and the 30 MiB file cap does not bound
/// them; `read_frame` hands image-webp's memory limit what the checked peak leaves, so the decode
/// fails before it builds them all.
#[test]
fn a_lossless_webp_with_65536_huffman_groups_is_refused_under_the_cap() {
    let bytes = webp(&[(b"VP8L", huffman_groups_vp8l(1, 1, false, 65_536))]);
    assert!(bytes.len() < memry_media::MAX_IMAGE_BYTES);
    let (result, peak) = peak_of(|| decode_fit(&bytes, 200));
    let error = result.expect_err("refused").to_string();
    assert!(error.to_lowercase().contains("memory limit"), "{error}");
    assert!(
        peak < CAP,
        "peak {peak} bytes from a {}-byte file",
        bytes.len()
    );
}

/// The Huffman tables live while the decoder fills the frame, and the pipeline's copies come only
/// after they are freed: a 72 Mpx RGBA image's 3,000 groups (about 60 MB of tables) fit beside its
/// frame and scratch, though not beside the copies. The stream has no pixel data, so the decode
/// fails after the tables, never at the memory limit.
#[test]
fn huffman_tables_get_the_room_beside_the_frame_not_beside_the_later_copies() {
    let bytes = webp(&[(b"VP8L", huffman_groups_vp8l(9_000, 8_000, true, 3_000))]);
    let (result, peak) = peak_of(|| memry_media::decode(&bytes));
    let error = result.expect_err("no pixel data").to_string();
    assert!(!error.to_lowercase().contains("memory limit"), "{error}");
    assert!(peak < CAP, "peak {peak} bytes");
}
