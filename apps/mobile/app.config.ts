import type { ExpoConfig } from 'expo/config'
import { withEntitlementsPlist } from 'expo/config-plugins'

/**
 * Native Google sign-in needs a Google Cloud project, and a build without one
 * must still prebuild and run. Both the config plugin and the client ids the
 * app reads are therefore conditional: absent credentials simply leave the
 * Google option off the sign-in screen. `GOOGLE_IOS_CLIENT_ID` looks like
 * `<id>.apps.googleusercontent.com`; its URL scheme is that value reversed.
 */
const googleIosClientId = process.env.GOOGLE_IOS_CLIENT_ID
const googleWebClientId = process.env.GOOGLE_WEB_CLIENT_ID
const googleSignIn =
  googleIosClientId && googleWebClientId
    ? { iosClientId: googleIosClientId, webClientId: googleWebClientId }
    : undefined
const reversedIosClientId = googleIosClientId?.split('.').reverse().join('.')

// Memry Mobile (spec 001-mobile-app). iOS 17+ target, dev-client + prebuild
// workflow, Hermes (SDK 57 default). Keys never leave expo-secure-store;
// production-safety constraints live in the sync server, not here.
const config: ExpoConfig = {
  name: 'Memry',
  slug: 'memry-mobile',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'memry',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'com.memry.mobile',
    appleTeamId: 'TV343Q4W8A',
    supportsTablet: false
    // Data-protection entitlement deliberately absent for now: iOS already
    // defaults third-party app files to
    // NSFileProtectionCompleteUntilFirstUserAuthentication — exactly the class
    // data-model.md §1 requires (DB readable when a BGAppRefreshTask runs
    // before first unlock) — and Xcode's wildcard dev provisioning profile
    // rejects the explicit entitlement. It returns with the real App Store
    // provisioning profile (Phase 6 signing work), where the capability is
    // registered on the App ID.
  },
  android: {
    package: 'com.memry.mobile',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png'
    },
    predictiveBackGestureEnabled: false
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        // No image: the native splash is a plain brand field that the JS
        // splash draws the wordmark on top of, so the handoff is seamless and
        // no new raster asset has to be kept in sync with the design.
        backgroundColor: '#ff671a'
      }
    ],
    [
      'expo-build-properties',
      {
        ios: {
          deploymentTarget: '17.0'
        }
      }
    ],
    [
      'expo-local-authentication',
      { faceIDPermission: 'Memry uses Face ID to unlock your vault on this device.' }
    ],
    [
      // Without this plugin the prebuilt Info.plist carries no
      // NSPhotoLibraryUsageDescription, and iOS kills the process the moment
      // the picker asks for photo access — inserting an image quits the app.
      // Camera and microphone are blocked on purpose: the app only ever reads
      // from the library, so it must not ask for either.
      'expo-image-picker',
      {
        photosPermission: 'Memry needs your photos so you can add one to a note.',
        cameraPermission: false,
        microphonePermission: false
      }
    ],
    ...(googleSignIn && reversedIosClientId
      ? ([
          ['@react-native-google-signin/google-signin', { iosUrlScheme: reversedIosClientId }]
        ] as NonNullable<ExpoConfig['plugins']>)
      : []),
    'react-native-libsodium',
    'expo-secure-store',
    'expo-background-task'
  ],
  extra: { googleSignIn },
  experiments: {
    typedRoutes: true,
    reactCompiler: true
  }
}

/**
 * `expo-notifications` is installed, so its iOS plugin runs on every prebuild
 * and writes `aps-environment` into the entitlements — the remote-push
 * capability. Memry never uses remote push; reminders are local
 * `scheduleNotificationAsync` calls (src/features/notes/reminder-notifications.ts).
 * The entitlement only breaks device builds: Xcode automatic signing falls back
 * to the wildcard "iOS Team Provisioning Profile: *", which cannot carry Push
 * Notifications, so xcodebuild refuses to sign. Same story as the
 * data-protection entitlement noted on `ios` above.
 *
 * Registering the mod here, on the exported config, is what makes the delete
 * stick: mods run in reverse registration order, and this one is registered
 * before any plugin is applied, so it is the last to touch the plist before it
 * is written. Adding it to `plugins` instead would run it *before*
 * expo-notifications, which would simply put the key back.
 */
export default withEntitlementsPlist(config, (entitlements) => {
  delete entitlements.modResults['aps-environment']
  return entitlements
})
