import type { CSSProperties, ReactElement } from 'react'
import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text
} from 'react-email'
import { trackedMemryUrl, WAITLIST_CAMPAIGNS } from './tracking-links'

export const openBetaLaunchContent = {
  subject: 'Memrynote is now in open beta',
  preview: 'One private place for notes, tasks, calendar, and journal — free to download today.'
} as const

export type OpenBetaLaunchEmailProps = {
  firstName?: string
  logoUrl?: string
  iconUrl?: string
  heroImageUrl?: string
  downloadUrl?: string
  unsubscribeUrl?: string
}

const defaultProps = {
  firstName: '',
  logoUrl: 'https://memrynote.com/memrynote-logo.png',
  iconUrl: 'https://memrynote.com/memrynote-icon.png',
  heroImageUrl: '',
  downloadUrl: trackedMemryUrl('/download/desktop', WAITLIST_CAMPAIGNS.openBeta, 'download_cta'),
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<OpenBetaLaunchEmailProps>

const homeUrl = trackedMemryUrl('/', WAITLIST_CAMPAIGNS.openBeta, 'logo')
const docsUrl = trackedMemryUrl('https://docs.memrynote.com/', WAITLIST_CAMPAIGNS.openBeta, 'docs')
const footerDownloadUrl = trackedMemryUrl(
  '/download/desktop',
  WAITLIST_CAMPAIGNS.openBeta,
  'footer_download'
)
const footerHomeUrl = trackedMemryUrl('/', WAITLIST_CAMPAIGNS.openBeta, 'footer_home')
const pricingUrl = trackedMemryUrl('/pricing', WAITLIST_CAMPAIGNS.openBeta, 'annual_discount')

// Must match the Paddle discount exactly (restricted to annual Plus + Pro).
const discountCode = 'WAITLIST20'

type EmailComponent = {
  (props: OpenBetaLaunchEmailProps): ReactElement
  PreviewProps?: OpenBetaLaunchEmailProps
}

export const OpenBetaLaunchEmail: EmailComponent = (props) => {
  const { firstName, logoUrl, iconUrl, heroImageUrl, downloadUrl, unsubscribeUrl } = {
    ...defaultProps,
    ...props
  }

  const greeting = firstName ? `Hi ${firstName},` : 'Hi,'

  return (
    <Html lang="en">
      <Head />
      <Preview>{openBetaLaunchContent.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.card}>
          <Section style={styles.header}>
            <Link href={homeUrl} style={styles.logoLink}>
              <Img src={logoUrl} alt="Memrynote" width="145" height="20" style={styles.logoImage} />
            </Link>
          </Section>

          <Section style={styles.main}>
            <Text style={styles.paragraph}>{greeting}</Text>

            <Text style={styles.paragraph}>
              Memrynote is now in open beta. Anyone can download it today — no invite, no waitlist.
            </Text>

            <Text style={styles.paragraph}>
              <strong>
                Memrynote brings your notes, tasks, calendar, and journal into one calm, private
                desktop app — local-first, end-to-end encrypted, and free during the open beta.
              </strong>
            </Text>

            <Text style={styles.paragraphTight}>
              Download it for macOS, Windows, or Linux and you&apos;ll be writing your first note in
              under a minute.
            </Text>

            <Section style={styles.buttonRow}>
              <Button href={downloadUrl} style={styles.button}>
                Download Memrynote
              </Button>
            </Section>

            <Hero url={heroImageUrl} href={downloadUrl} />

            <Text style={styles.listHeading}>
              <strong>What you get:</strong>
            </Text>

            <ul style={styles.list}>
              <li style={styles.listItem}>
                Notes, tasks, calendar, and journal in one place — no more app-switching.
              </li>
              <li style={styles.listItem}>
                Private by default. Your data lives on your device, and sync is end-to-end
                encrypted.
              </li>
              <li style={styles.listItem}>
                Import from Notion, Obsidian, Apple Notes, Bear, and more in a few clicks.
              </li>
            </ul>

            <Text style={styles.paragraph}>
              And a waitlist thank-you: when you&apos;re ready to sync across devices, annual{' '}
              <Link href={pricingUrl} style={styles.inlineLink}>
                Plus and Pro plans
              </Link>{' '}
              are <strong>20% off</strong> with code <span style={styles.code}>{discountCode}</span>{' '}
              at checkout.
            </Text>

            <Text style={styles.paragraphBottom}>
              It&apos;s a beta — if anything breaks or feels off, reply to this email or use the
              Feedback button in the app. We read every message. Learn more in our{' '}
              <Link href={docsUrl} style={styles.inlineLink}>
                docs
              </Link>{' '}
              and on{' '}
              <Link href={footerHomeUrl} style={styles.inlineLink}>
                memrynote.com
              </Link>
              .
            </Text>

            <Text style={styles.signoff}>Best,</Text>
            <Text style={styles.signature}>Kaan</Text>

            <Hr style={styles.hr} />
          </Section>

          <Section style={styles.footer}>
            <Section style={styles.footerLogo}>
              <Img src={iconUrl} alt="Memrynote" width="34" height="27" style={styles.logoImage} />
            </Section>

            <Text style={styles.footerLinks}>
              <Link href={footerDownloadUrl} style={styles.footerLink}>
                Download Memrynote
              </Link>{' '}
              ·{' '}
              <Link href={docsUrl} style={styles.footerLink}>
                Docs
              </Link>{' '}
              ·{' '}
              <Link href={footerHomeUrl} style={styles.footerLink}>
                memrynote.com
              </Link>
            </Text>

            <Text style={styles.footerLine}>© 2026 Memrynote</Text>

            <Text style={styles.footerUnsubscribe}>
              <Link href={unsubscribeUrl} style={styles.footerLink}>
                Unsubscribe
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

function Hero({ url, href }: { url: string; href: string }) {
  if (url) {
    return (
      <Link href={href} style={styles.heroLink}>
        <Img
          src={url}
          alt="Memrynote — notes, tasks, calendar, and journal in one desktop app"
          width="570"
          style={styles.heroImage}
        />
      </Link>
    )
  }

  return (
    <Section style={styles.placeholder}>
      <Text style={styles.placeholderLabel}>Hero: Memrynote running on macOS or Windows</Text>
      <Text style={styles.placeholderHint}>
        1140×740 hosted PNG or JPG, under 300KB, shown at 570px. Replace before sending.
      </Text>
    </Section>
  )
}

OpenBetaLaunchEmail.PreviewProps = defaultProps

export default OpenBetaLaunchEmail

const systemFont =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"

const styles = {
  body: {
    margin: 0,
    backgroundColor: '#f4f3ef',
    fontFamily: systemFont,
    color: '#000000'
  },
  card: {
    width: '100%',
    maxWidth: '620px',
    margin: '0 auto',
    backgroundColor: '#faf9f7'
  },
  header: {
    padding: '13px 25px',
    minHeight: '48px'
  },
  logoLink: {
    display: 'inline-block',
    textDecoration: 'none'
  },
  logoImage: {
    display: 'block',
    maxWidth: '100%'
  },
  main: {
    padding: '32px 25px 0'
  },
  paragraph: {
    margin: '0 0 16px',
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  paragraphTight: {
    margin: '0 0 21px',
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  buttonRow: {
    margin: '16px 0'
  },
  button: {
    display: 'inline-block',
    padding: '11px 18px',
    borderRadius: '8px',
    backgroundColor: '#000000',
    color: '#faf9f7',
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    textAlign: 'center',
    textDecoration: 'none'
  },
  heroLink: {
    display: 'inline-block',
    borderRadius: '8px',
    overflow: 'hidden'
  },
  heroImage: {
    display: 'block',
    width: '100%',
    maxWidth: '570px',
    height: 'auto',
    borderRadius: '8px'
  },
  placeholder: {
    margin: '16px 0 0',
    padding: '40px 24px',
    border: '1px dashed #d0d0d0',
    borderRadius: '8px',
    backgroundColor: '#f4f3ef',
    textAlign: 'center'
  },
  placeholderLabel: {
    margin: '0 0 6px',
    color: '#555555',
    fontSize: '14px',
    lineHeight: '20px',
    fontWeight: 600
  },
  placeholderHint: {
    margin: 0,
    color: '#888888',
    fontSize: '12px',
    lineHeight: '18px'
  },
  listHeading: {
    margin: '21px 0 0',
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  list: {
    margin: '8px 0 16px',
    paddingLeft: '24px'
  },
  listItem: {
    margin: '0 0 8px',
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  paragraphBottom: {
    margin: '0 0 21px',
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  inlineLink: {
    color: '#000000',
    fontWeight: 400,
    textDecoration: 'underline'
  },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: '4px',
    backgroundColor: '#f4f3ef',
    border: '1px solid #e0dfdd'
  },
  signoff: {
    margin: 0,
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  signature: {
    margin: '0 0 16px',
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  hr: {
    margin: '52px 0',
    border: 'none',
    borderTop: '1px solid #e0dfdd'
  },
  footer: {
    padding: '0 25px'
  },
  footerLogo: {
    margin: '0 0 21px'
  },
  footerLinks: {
    margin: '0 0 21px',
    color: '#808080',
    fontSize: '14px',
    lineHeight: '21px'
  },
  footerLink: {
    color: '#808080',
    fontWeight: 400,
    textDecoration: 'underline'
  },
  footerLine: {
    margin: '0 0 21px',
    color: '#808080',
    fontSize: '14px',
    lineHeight: '21px'
  },
  footerUnsubscribe: {
    margin: '0 0 52px',
    color: '#808080',
    fontSize: '14px',
    lineHeight: '21px'
  }
} satisfies Record<string, CSSProperties>
