# Spike evidence

Screenshots quoted by `specs/002-native-foundation-ios/research.md` §Addenda,
spike S3. iPhone 17 simulator, iOS 26.5 (23F77), Xcode 26.6 (17F113), hardware
keyboard disconnected.

- `S3-keyboard-toolbar-default.png` — the `inputAccessoryView` override showing
  the SwiftUI toolbar above the software keyboard. Badge reads `RT OFF`.
- `S3-keyboard-toolbar-reduce-transparency.png` — the same toolbar with Reduce
  Transparency on. Badge reads `RT ON` and the banner reads
  `ReduceTransparency=ON`, so the screenshot carries its own proof of condition.

**Simulator, not device.** T081 asks for device screenshots; the device tier is
blocked by decision. These settle the accessory-view override and the Reduce
Transparency code path, not GPU-dependent Liquid Glass rendering on hardware.
