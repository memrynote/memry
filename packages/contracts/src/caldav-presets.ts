/**
 * CalDAV server presets for the connect form (#1401). A preset fills in the
 * server address the user would otherwise have to look up; discovery does
 * the rest. `serverUrl` null means the user types an address (self-hosted
 * servers, LAN addresses included). `hostTemplate` builds the address from a
 * host name the user types.
 */
export type CaldavPresetId =
  | 'icloud'
  | 'fastmail'
  | 'nextcloud'
  | 'self-hosted'
  | 'zoho'
  | 'yahoo'
  | 'mailbox-org'
  | 'posteo'
  | 'synology'
  | 'other'

export interface CaldavPreset {
  id: CaldavPresetId
  serverUrl: string | null
  /** `{host}` is replaced by what the user types. */
  hostTemplate?: string
  /** Where the provider lets users create an app password for memrynote, when it has one. */
  appAccessHelpUrl?: string
  /** The docs page with this preset's steps, under the docs site. */
  docsPath: string
}

export const CALDAV_PRESETS: readonly CaldavPreset[] = [
  {
    id: 'icloud',
    serverUrl: 'https://caldav.icloud.com/',
    appAccessHelpUrl: 'https://account.apple.com/account/manage',
    docsPath: '/user-guide/caldav/icloud'
  },
  {
    id: 'fastmail',
    serverUrl: 'https://caldav.fastmail.com/',
    appAccessHelpUrl: 'https://app.fastmail.com/settings/security/apps',
    docsPath: '/user-guide/caldav/fastmail'
  },
  {
    id: 'nextcloud',
    serverUrl: null,
    hostTemplate: 'https://{host}/remote.php/dav/',
    docsPath: '/user-guide/caldav/nextcloud'
  },
  { id: 'self-hosted', serverUrl: null, docsPath: '/user-guide/caldav/self-hosted' },
  { id: 'zoho', serverUrl: 'https://calendar.zoho.com/', docsPath: '/user-guide/caldav/zoho' },
  {
    id: 'yahoo',
    serverUrl: 'https://caldav.calendar.yahoo.com/',
    docsPath: '/user-guide/caldav/yahoo'
  },
  {
    id: 'mailbox-org',
    serverUrl: 'https://dav.mailbox.org/',
    docsPath: '/user-guide/caldav/mailbox-org'
  },
  { id: 'posteo', serverUrl: 'https://posteo.de:8443/', docsPath: '/user-guide/caldav/posteo' },
  { id: 'synology', serverUrl: null, docsPath: '/user-guide/caldav/synology' },
  { id: 'other', serverUrl: null, docsPath: '/user-guide/caldav/' }
]

export function caldavPreset(id: string | null | undefined): CaldavPreset | null {
  return CALDAV_PRESETS.find((preset) => preset.id === id) ?? null
}

/** The server address a preset and what the user typed resolve to. */
export function caldavPresetServerUrl(preset: CaldavPreset, typed: string): string {
  if (preset.serverUrl) return preset.serverUrl
  if (preset.hostTemplate) {
    const host = typed
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/\/.*$/, '')
    return host ? preset.hostTemplate.replace('{host}', host) : ''
  }
  return typed.trim()
}
