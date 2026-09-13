# B0 spike scaffolding

Gate G3a, tasks T079–T083. `research.md` §Addenda holds the four notes; this
directory holds the code that produced them.

Research §F: "No product code comes out of B0 and nothing in phase A or B
depends on its artifacts." Nothing here is a seam implementation, a Keychain,
or an editor host — the `SecureStore` is in-memory, the stub `Transport`
answers from a table, and the WebView loads a six-line document. Delete the
directory, `apps/ios/MemryTests/SpikeTests.swift`, the two
`apps/ios/MemryUITests/Spike*UITests.swift` files and the `--spike-s3` branch in
`MemryApp.swift` when phase C1 replaces them with the real thing.

Two pieces are worth reading before the real ones are written, because they are
the measured answer rather than a guess:

- `SpikeURLSessionTransport.swift` — the `URLError` → `TransportError` mapping,
  including the `Cancelled` case the core must not retry.
- `SpikeSchemeHandlerFallback.swift` — R10's fallback with the document-start
  storage denial that its admissibility condition turned out to require.

Run them:

```bash
while ! mkdir ~/.memry/xcodebuild.lock 2>/dev/null; do sleep 10; done
xcodebuild test -project apps/ios/Memry.xcodeproj -scheme Memry -testPlan Unit \
  -destination 'platform=iOS Simulator,name=iPhone 17'
rmdir ~/.memry/xcodebuild.lock
```

The S3 screenshots need the simulator's hardware keyboard disconnected (⇧⌘K),
and Reduce Transparency has to be toggled through Settings — `defaults write
com.apple.Accessibility ReduceTransparencyEnabled` does not reach
`UIAccessibility`. `SpikeReduceTransparencyUITests` drives the switch.
