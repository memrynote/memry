import type { ExpoConfig } from 'expo/config'

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
        backgroundColor: '#208AEF',
        image: './assets/images/splash-icon.png',
        imageWidth: 76
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
    'react-native-libsodium',
    'expo-secure-store',
    'expo-background-task'
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true
  }
}

export default config
