import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { Img, Link, Section, Text } from 'react-email'
import { trackedMemryUrl, type WaitlistCampaignId } from './tracking-links'

// The same Discord invite as DISCORD_URL in apps/landing/src/lib/constants.ts.
const DISCORD_URL = 'https://discord.gg/NkCvW3uE75'

const footerLinks = [
  { label: 'Download Memrynote', url: '/download', content: 'footer_download' },
  { label: 'Docs', url: 'https://docs.memrynote.com/', content: 'footer_docs' },
  { label: 'memrynote.com', url: '/', content: 'footer_home' },
  { label: 'r/MemryNote', url: 'https://www.reddit.com/r/MemryNote/', content: 'footer_reddit' },
  { label: 'YouTube', url: 'https://www.youtube.com/@memrynote', content: 'footer_youtube' },
  { label: 'Discord', url: DISCORD_URL, content: 'footer_discord' },
  { label: '@MemryNote', url: 'https://x.com/MemryNote', content: 'footer_x' }
] as const

/**
 * Footer for campaigns written from November 2026 on. Sent templates keep the footer they
 * went out with. The unsubscribe link and the sender identity are required by law.
 */
export function EmailFooter({
  campaign,
  logoUrl = 'https://memrynote.com/memrynote-logo.png',
  unsubscribeUrl = '{{{RESEND_UNSUBSCRIBE_URL}}}'
}: {
  campaign: WaitlistCampaignId
  logoUrl?: string
  unsubscribeUrl?: string
}): ReactNode {
  return (
    <Section style={styles.footer}>
      <Img src={logoUrl} alt="Memrynote" width="185" height="26" style={styles.logo} />

      <Text style={styles.text}>
        {footerLinks.map((link, index) => (
          <Fragment key={link.label}>
            {index > 0 && ' · '}
            <Link href={trackedMemryUrl(link.url, campaign, link.content)} style={styles.link}>
              {link.label}
            </Link>
          </Fragment>
        ))}
        <br />
        <span style={styles.muted}>© 2026 Memrynote</span>
        <br />
        <Link href={unsubscribeUrl} style={styles.link}>
          <u>Unsubscribe</u>
        </Link>
      </Text>
    </Section>
  )
}

const styles = {
  footer: {
    fontSize: '11px'
  },
  logo: {
    display: 'block',
    outline: 'none',
    border: 'none',
    textDecoration: 'none',
    padding: '10px 0'
  },
  text: {
    margin: 0,
    padding: '7px 0',
    color: '#a8a29e',
    fontSize: '11px',
    fontWeight: 400,
    lineHeight: '18px',
    textAlign: 'center'
  },
  link: {
    color: '#ff671a',
    fontWeight: 400,
    textDecoration: 'underline'
  },
  muted: {
    color: '#a8a29e'
  }
} satisfies Record<string, CSSProperties>
