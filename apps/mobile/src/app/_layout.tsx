// Hermes has no global crypto.getRandomValues; nanoid (via @memry/app-core)
// needs it. Must be the first import (R3 spike finding).
import '@/lib/crypto-polyfill'

import { useFonts } from 'expo-font'
import { DarkTheme, DefaultTheme, ThemeProvider, Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useColorScheme } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { AnimatedSplashOverlay } from '@/components/animated-icon'
import { fontAssets } from '@/theme/fonts'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const colorScheme = useColorScheme()
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
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
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
