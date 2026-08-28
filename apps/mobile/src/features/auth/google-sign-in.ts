import Constants from 'expo-constants'

import { createLogger } from '@/lib/logger'
import { signInWithGoogleIdToken } from '@/sync/auth-client'

const log = createLogger('GoogleSignIn')

export interface GoogleSignInConfig {
  iosClientId: string
  webClientId: string
}

/**
 * Native Google sign-in is credential-gated, not feature-flagged.
 *
 * The client ids come from a Google Cloud project, so a build without them
 * cannot sign anyone in. Rather than render a button that fails on tap, the
 * screen asks for this first and leaves the option out entirely when it is
 * absent. Configure `extra.googleSignIn` in `app.config.ts` to switch it on.
 */
export function googleSignInConfig(): GoogleSignInConfig | null {
  const extra = Constants.expoConfig?.extra as
    { googleSignIn?: Partial<GoogleSignInConfig> } | undefined
  const { iosClientId, webClientId } = extra?.googleSignIn ?? {}
  if (!iosClientId || !webClientId) return null
  return { iosClientId, webClientId }
}

export class GoogleSignInCancelled extends Error {
  constructor() {
    super('Google sign-in was dismissed')
    this.name = 'GoogleSignInCancelled'
  }
}

/**
 * Run the native sheet and trade the resulting ID token for a Memry session.
 *
 * The SDK is imported lazily so a build with no client ids never loads it, and
 * `signInWithGoogleIdToken` finishes on the same device-registration path the
 * one-time-code route uses.
 */
export async function signInWithGoogle(
  config: GoogleSignInConfig
): Promise<{ needsSetup: boolean }> {
  const { GoogleSignin, statusCodes } = await import('@react-native-google-signin/google-signin')

  GoogleSignin.configure({
    iosClientId: config.iosClientId,
    // Google issues the ID token for the web client when one is configured, and
    // the server validates the audience, so the two must be set together.
    webClientId: config.webClientId
  })

  try {
    const response = await GoogleSignin.signIn()
    if (response.type === 'cancelled') throw new GoogleSignInCancelled()
    const { idToken, user } = response.data
    if (!idToken) throw new Error('Google returned no ID token')
    return await signInWithGoogleIdToken(user.email, idToken)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === statusCodes.SIGN_IN_CANCELLED) throw new GoogleSignInCancelled()
    log.warn('Google sign-in failed', { error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}
