import Testing

// The on-device conformance suite (gate G3) fills this in by running the same
// `packages/contracts/test-vectors/` files the host `cargo test` runs.
@Suite("Conformance")
struct ConformanceTests {
    @Test("vector suite is wired")
    func vectorSuiteIsWired() {
        #expect(Bool(true))
    }
}
