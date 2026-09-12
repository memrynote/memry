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
        .target(
            name: "MemryCore",
            dependencies: ["MemryCoreFFI"],
            path: "Sources/MemryCore",
            swiftSettings: [.swiftLanguageMode(.v6)]
        )
    ]
)
