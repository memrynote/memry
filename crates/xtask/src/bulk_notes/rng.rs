//! `createRng` of `bulk-notes.ts`: mulberry32, with `Math.imul` as a wrapping 32-bit multiply.

pub(super) struct Rng {
    state: u32,
}

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// The next draw in `[0, 1)`.
    pub fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    /// `Math.floor(rng() * n)`.
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() * n as f64).floor() as usize
    }

    /// `pick`: `items[Math.floor(rng() * items.length) % items.length]`.
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len()) % items.len()]
    }
}
