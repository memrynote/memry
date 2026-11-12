import Foundation
import Testing

// The app ships as one Universal build. These keys decide whether iPadOS runs
// it natively with resizable windows, or as a scaled-up phone, and App Store
// validation rejects an iPad build without all four orientations.
@Suite("Universal build")
struct UniversalBuildTests {
    // The raw file: `Bundle.infoDictionary` drops `~ipad` keys on an iPhone.
    private let info: [String: Any] = {
        guard let url = Bundle.main.url(forResource: "Info", withExtension: "plist"),
            let dict = NSDictionary(contentsOf: url) as? [String: Any]
        else { return [:] }
        return dict
    }()

    @Test func runsNativelyOnIPhoneAndIPad() {
        let families = info["UIDeviceFamily"] as? [Int] ?? []
        #expect(Set(families) == [1, 2])
    }

    @Test func iPadSupportsEveryOrientation() {
        let orientations = info["UISupportedInterfaceOrientations~ipad"] as? [String] ?? []
        #expect(
            Set(orientations) == [
                "UIInterfaceOrientationPortrait",
                "UIInterfaceOrientationPortraitUpsideDown",
                "UIInterfaceOrientationLandscapeLeft",
                "UIInterfaceOrientationLandscapeRight",
            ])
    }

    @Test func keepsASingleScene() {
        let manifest = info["UIApplicationSceneManifest"] as? [String: Any] ?? [:]
        #expect(manifest["UIApplicationSupportsMultipleScenes"] as? Bool == false)
    }
}
