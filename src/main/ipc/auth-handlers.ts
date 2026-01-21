/**
 * Auth IPC handlers.
 * Handles OTP, OAuth, and session management IPC communication.
 *
 * T054: Request OTP handler
 * T055: Verify OTP handler
 * T056: Resend OTP handler
 * T056a: OTP clipboard detection
 * T057: OAuth handlers
 *
 * @module ipc/auth-handlers
 */

import { ipcMain, clipboard, shell, BrowserWindow } from 'electron'
import crypto from 'node:crypto'
import { AuthChannels } from '@shared/contracts/ipc-sync'
import type {
  RequestOtpResponse,
  VerifyOtpResponse,
  ResendOtpResponse,
  DetectOtpClipboardResponse,
  StartOAuthResponse,
  LogoutResponse
} from '@shared/contracts/ipc-sync'
import {
  RequestOtpRequestSchema,
  VerifyOtpRequestSchema,
  ResendOtpRequestSchema,
  StartOAuthRequestSchema
} from '@shared/contracts/ipc-sync'
import { createValidatedHandler, createHandler } from './validate'
import { getSyncApiClient, isSyncApiError } from '../sync/api-client'
import {
  storeAuthTokens,
  retrieveAuthTokens,
  deleteAuthTokens,
  deleteKeyMaterial,
  deleteDeviceKeyPair,
  deleteSigningKeyPair
} from '../crypto/keychain'
import { createOAuthServer, type OAuthServer } from '../auth/oauth-server'

let activeOAuthServer: OAuthServer | null = null

function emitSessionChanged(isAuthenticated: boolean, user?: { id: string; email: string }): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(AuthChannels.events.SESSION_CHANGED, {
      isAuthenticated,
      user
    })
  })
}

export function registerAuthHandlers(): void {
  // ==========================================================================
  // T054: Request OTP Handler
  // ==========================================================================
  ipcMain.handle(
    AuthChannels.invoke.REQUEST_OTP,
    createValidatedHandler(
      RequestOtpRequestSchema,
      async ({ email }): Promise<RequestOtpResponse> => {
        try {
          const client = getSyncApiClient()
          const response = await client.requestOtp(email)
          return {
            success: response.success,
            expiresAt: response.expiresAt
          }
        } catch (error) {
          console.error('[Auth] REQUEST_OTP error:', error)
          const message = isSyncApiError(error)
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Failed to request OTP'
          return { success: false, expiresAt: 0, error: message }
        }
      }
    )
  )

  // ==========================================================================
  // T055: Verify OTP Handler
  // ==========================================================================
  ipcMain.handle(
    AuthChannels.invoke.VERIFY_OTP,
    createValidatedHandler(
      VerifyOtpRequestSchema,
      async ({ email, code }): Promise<VerifyOtpResponse> => {
        try {
          const client = getSyncApiClient()
          const response = await client.verifyOtp(email, code)

          await storeAuthTokens({
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            userId: response.user.id,
            email: response.user.email
          })

          const needsSetup = !response.user.emailVerified || response.device === undefined

          emitSessionChanged(true, { id: response.user.id, email: response.user.email })

          return {
            success: true,
            isNewUser: needsSetup,
            needsSetup
          }
        } catch (error) {
          console.error('[Auth] VERIFY_OTP error:', error)
          const message = isSyncApiError(error)
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Failed to verify OTP'
          return { success: false, error: message }
        }
      }
    )
  )

  // ==========================================================================
  // T056: Resend OTP Handler
  // ==========================================================================
  ipcMain.handle(
    AuthChannels.invoke.RESEND_OTP,
    createValidatedHandler(
      ResendOtpRequestSchema,
      async ({ email }): Promise<ResendOtpResponse> => {
        try {
          const client = getSyncApiClient()
          const response = await client.resendOtp(email)
          return {
            success: response.success,
            expiresAt: response.expiresAt
          }
        } catch (error) {
          console.error('[Auth] RESEND_OTP error:', error)
          const message = isSyncApiError(error)
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Failed to resend OTP'
          return { success: false, expiresAt: 0, error: message }
        }
      }
    )
  )

  // ==========================================================================
  // T056a: OTP Clipboard Detection Handler
  // ==========================================================================
  ipcMain.handle(
    AuthChannels.invoke.DETECT_OTP_CLIPBOARD,
    createHandler((): DetectOtpClipboardResponse => {
      const clipboardText = clipboard.readText().trim()
      if (/^\d{6}$/.test(clipboardText)) {
        return { code: clipboardText }
      }
      return { code: null }
    })
  )

  // ==========================================================================
  // Session Management (Stub handlers for now)
  // ==========================================================================
  ipcMain.handle(
    AuthChannels.invoke.GET_SESSION,
    createHandler(async () => {
      const tokens = await retrieveAuthTokens()
      if (!tokens) {
        return { isAuthenticated: false }
      }
      return {
        isAuthenticated: true,
        user: {
          id: tokens.userId,
          email: tokens.email
        }
      }
    })
  )

  ipcMain.handle(
    AuthChannels.invoke.GET_ACCESS_TOKEN,
    createHandler(async () => {
      const tokens = await retrieveAuthTokens()
      return tokens?.accessToken ?? null
    })
  )

  ipcMain.handle(
    AuthChannels.invoke.GET_REFRESH_TOKEN,
    createHandler(async () => {
      const tokens = await retrieveAuthTokens()
      return tokens?.refreshToken ?? null
    })
  )

  // ==========================================================================
  // T057: OAuth Handlers
  // ==========================================================================
  ipcMain.handle(
    AuthChannels.invoke.START_OAUTH,
    createValidatedHandler(
      StartOAuthRequestSchema,
      async ({ provider }): Promise<StartOAuthResponse> => {
        try {
          const codeVerifier = crypto.randomBytes(32).toString('base64url')
          const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')

          const state = crypto.randomBytes(16).toString('hex')

          activeOAuthServer = await createOAuthServer({ expectedState: state })

          const client = getSyncApiClient()
          const response = await client.initiateOAuth(provider, {
            redirectUri: activeOAuthServer.callbackUrl,
            codeChallenge,
            state
          })

          await shell.openExternal(response.authUrl)

          const result = await activeOAuthServer.waitForCode()

          const tokenResponse = await client.exchangeOAuthCode(provider, {
            code: result.code,
            codeVerifier,
            redirectUri: activeOAuthServer.callbackUrl
          })

          await storeAuthTokens({
            accessToken: tokenResponse.accessToken,
            refreshToken: tokenResponse.refreshToken,
            userId: tokenResponse.user.id,
            email: tokenResponse.user.email
          })

          emitSessionChanged(true, { id: tokenResponse.user.id, email: tokenResponse.user.email })

          return { success: true, isNewUser: tokenResponse.isNewUser }
        } catch (error) {
          console.error('[Auth] START_OAUTH error:', error)
          activeOAuthServer?.close()
          activeOAuthServer = null
          const message = isSyncApiError(error)
            ? error.message
            : error instanceof Error
              ? error.message
              : 'OAuth failed'
          return { success: false, error: message }
        }
      }
    )
  )

  ipcMain.handle(
    AuthChannels.invoke.REFRESH_SESSION,
    createHandler(async () => {
      const tokens = await retrieveAuthTokens()
      if (!tokens?.refreshToken) {
        return { success: false, error: 'No refresh token' }
      }
      try {
        const client = getSyncApiClient()
        const response = await client.refreshToken(tokens.refreshToken)
        await storeAuthTokens({
          ...tokens,
          accessToken: response.accessToken,
          refreshToken: response.refreshToken
        })
        return { success: true }
      } catch (error) {
        console.error('[Auth] REFRESH_SESSION error:', error)
        const message = isSyncApiError(error)
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Session refresh failed'
        return { success: false, error: message }
      }
    })
  )

  ipcMain.handle(
    AuthChannels.invoke.LOGOUT,
    createHandler(async (): Promise<LogoutResponse> => {
      try {
        const tokens = await retrieveAuthTokens()
        if (tokens?.accessToken) {
          try {
            const client = getSyncApiClient()
            await client.logout(tokens.accessToken, { refreshToken: tokens.refreshToken })
          } catch (error) {
            console.warn('[Auth] Server logout failed, continuing with local cleanup:', error)
          }
        }

        await deleteAuthTokens()
        await deleteKeyMaterial()
        await deleteDeviceKeyPair()
        await deleteSigningKeyPair()

        emitSessionChanged(false)

        return { success: true }
      } catch (error) {
        console.error('[Auth] LOGOUT error:', error)
        return { success: false }
      }
    })
  )

  console.log('[IPC] Auth handlers registered')
}

export function unregisterAuthHandlers(): void {
  Object.values(AuthChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
  console.log('[IPC] Auth handlers unregistered')
}
