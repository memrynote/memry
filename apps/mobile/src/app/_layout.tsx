// Hermes has no global crypto.getRandomValues; nanoid (via @memry/app-core)
// needs it. Must be the first import (R3 spike finding).
import '@/lib/crypto-polyfill'

import { useFonts } from 'expo-font'
import { DefaultTheme, ThemeProvider, Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { AnimatedSplashOverlay } from '@/components/animated-icon'
import { fontAssets } from '@/theme/fonts'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontAssets)

  return (
    /*
      The native container that delivers touches to every gesture handler under
      it; a handler mounted outside one never receives an event. Outside the
      font gate for the same reason the splash overlay is: inside it, every
      gesture in the app would be dead until fonts resolve, and dead forever if
      useFonts never reaches a terminal state.
    */
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/*
        Always the light container (#2033). This sets the background React
        Navigation paints behind and between screens, and the app has one
        palette — `useColors()` returns the white theme regardless of the
        device — so a dark container here showed through as dark edges under
        light chrome. When a real dark palette lands, this and the `cfg.theme`
        the note screen sends are the two sites that re-wire.
      */}
      <ThemeProvider value={DefaultTheme}>
        {/*
          Mounted outside the font gate on purpose. This overlay is what calls
          SplashScreen.hideAsync, so no font outcome can strand the native splash
          on screen. The gate below opens on either terminal state of useFonts,
          and a font failure renders the app with system fallbacks.
        */}
        <AnimatedSplashOverlay />
        {fontsLoaded || fontError ? (
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(vault)" />
            <Stack.Screen name="(dev)" />
          </Stack>
        ) : null}
      </ThemeProvider>
    </GestureHandlerRootView>
  )
}
