// swift-tools-version: 6.2
import PackageDescription

// Local package, never published. `MemryCoreFFI.xcframework` is produced by
// `crates/memry-core/build-xcframework.sh` and committed alongside the generated
// Swift in Sources/MemryCore/Generated/.
let package = Package(
    name: "MemryCore",
    platforms: [.iOS(.v26), .macOS(.v15)],
    products: [
        .library(name: "MemryCore", targets: ["MemryCore"])
    ],
    targets: [
        .binaryTarget(
            name: "MemryCoreFFI",
            path: "MemryCoreFFI.xcframework"
        ),
        // The generated bindings are their own target, in Swift 5 language
        // mode, and this is deliberate rather than a concession.
        //
        // UniFFI 0.32.1 emits `uniffiTraitInterfaceCallAsync`, which passes an
        // `@escaping () async throws -> T` into `Task { }`. Under Swift 6
        // language mode that is an error — the closure is a `sending`
        // parameter and capturing `makeCall` risks a data race — so the whole
        // package failed to build the moment the FFI surface gained its first
        // async object. We do not write this file and `build-xcframework.sh`
        // overwrites it, so patching it is not an option; relaxing the mode
        // for the *target that contains it* is the smallest correct scope.
        //
        // Our own code does not get the discount: `MemryCore` below stays at
        // Swift 6. Revisit when UniFFI emits Swift 6 clean.
        .target(
            name: "MemryCoreGenerated",
            dependencies: ["MemryCoreFFI"],
            path: "Sources/MemryCore/Generated",
            swiftSettings: [.swiftLanguageMode(.v5)],
            // The core compresses with stock zlib, not `miniz_oxide`, and that
            // is a protocol requirement rather than a preference: only stock
            // zlib at level 6 reproduces `pako`'s bytes, which
            // `compression.json` pins (chapter 04 §4.1.1, spec defect 1).
            //
            // `flate2`'s `zlib` feature therefore links against the *system*
            // zlib. On the host cargo passes `-lz` for us; an iOS app links
            // nothing of the sort, so `libmemry_core.a` arrives with
            // `_deflate`, `_deflateEnd`, `_deflateInit2_` and friends
            // undefined and the app fails to link. Apple ships `libz` in every
            // SDK, so naming it here — once, beside the binary target — is all
            // any consumer needs.
            linkerSettings: [.linkedLibrary("z")]
        ),
        .target(
            name: "MemryCore",
            dependencies: ["MemryCoreGenerated"],
            path: "Sources/MemryCore",
            exclude: ["Generated"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        )
    ]
)
