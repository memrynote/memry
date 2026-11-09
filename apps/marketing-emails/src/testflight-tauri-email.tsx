import type { CSSProperties, ReactElement, ReactNode } from 'react'
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text
} from 'react-email'
import { EmailFooter } from './email-footer'
import { trackedMemryUrl, WAITLIST_CAMPAIGNS } from './tracking-links'

export const testflightTauriContent = {
  subject: 'Memrynote for iPhone is on TestFlight, and the desktop app is moving to Tauri',
  preview:
    'The iPhone beta is open, and your TestFlight invite is already in your inbox. And over the next month or so, the desktop app moves from Electron to Tauri.'
} as const

export type TestflightTauriEmailProps = {
  firstName?: string
  logoUrl?: string
  iconUrl?: string
  iosImageUrl?: string
  unsubscribeUrl?: string
}

const campaign = WAITLIST_CAMPAIGNS.testflightTauri

// Served from apps/landing/public/email/2026-11. They load only after a landing deploy, in the
// exported HTML and in Resend alike.
const assetsUrl = 'https://memrynote.com/email/2026-11'

const defaultProps = {
  firstName: '',
  logoUrl: 'https://memrynote.com/memrynote-logo.png',
  iconUrl: 'https://memrynote.com/memrynote-icon.png',
  iosImageUrl: `${assetsUrl}/ios.gif`,
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<TestflightTauriEmailProps>

const homeUrl = trackedMemryUrl('/', campaign, 'logo')
// Every address on this list already has a TestFlight invite; /ios-beta sends one to another.
const iosBetaUrl = trackedMemryUrl('/ios-beta', campaign, 'ios_beta')
const docsUrl = trackedMemryUrl('https://docs.memrynote.com/', campaign, 'docs')
const roadmapUrl = trackedMemryUrl('/roadmap', campaign, 'roadmap')
const releaseNotesUrl = trackedMemryUrl(
  'https://github.com/memrynote/memry/releases',
  campaign,
  'release_notes'
)
const twitterUrl = trackedMemryUrl('https://x.com/h4yfans', campaign, 'twitter')

type EmailComponent = {
  (props: TestflightTauriEmailProps): ReactElement
  PreviewProps?: TestflightTauriEmailProps
}

export const TestflightTauriEmail: EmailComponent = (props) => {
  const { firstName, logoUrl, iconUrl, iosImageUrl, unsubscribeUrl } = {
    ...defaultProps,
    ...props
  }

  const greeting = firstName ? `Hi ${firstName} 👋` : 'Hi 👋'

  return (
    <Html lang="en">
      <Head />
      <Preview>{testflightTauriContent.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Link href={homeUrl} style={styles.logoLink}>
            <Img src={iconUrl} alt="Memrynote" width="45" height="36" style={styles.headerIcon} />
          </Link>

          <Hr style={styles.divider} />

          <Text style={styles.paragraph}>{greeting}</Text>

          <Text style={styles.paragraph}>
            It&apos;s{' '}
            <Link href={twitterUrl} style={styles.link}>
              Kaan
            </Link>{' '}
            again. This one is short and has two things in it: the iPhone beta is open, and the
            desktop app is about to change underneath.
          </Text>

          <Spacer />

          <Heading as="h2" style={styles.h2}>
            The iPhone Beta Is Open
          </Heading>

          <Text style={styles.paragraph}>
            Memrynote for iPhone is now on TestFlight, and I have already sent a TestFlight invite
            to the address this email came to. Look for an email from TestFlight and open it on your
            iPhone. It is a native app, and it opens the same vault as your desktop with the same
            end-to-end encryption. Your notes, tasks, journal and calendar sync to your phone, and
            the server still cannot read any of it.
          </Text>

          <Spacer />

          <Media
            url={iosImageUrl}
            alt="Memrynote on iPhone: Tasks, a note, the journal, the calendar and the inbox"
            label="iOS: Memrynote on an iPhone"
            hint="iosImageUrl: the animated GIF from the October update."
          />

          <Text style={styles.paragraph}>You need iOS 26 or later and the TestFlight app.</Text>

          <Text style={styles.paragraph}>
            <strong>Your invite is already in your inbox</strong>, in a separate email from
            TestFlight. Want it at a different email instead? Get a new one here:
          </Text>

          <Section style={styles.buttonRow}>
            <Button href={iosBetaUrl} style={styles.button}>
              Get the invite at another email
            </Button>
          </Section>

          <Text style={styles.paragraph}>
            <strong>Free and paid.</strong> Everyone in the beta can keep using the iPhone app for
            free. It works on its own on your phone, offline, with its own vault. If you want the
            notes, tasks, journal and calendar from your desktop vault on your phone, you need a
            paid plan. With one, you can see, manage and edit your existing vault on the iPhone.
            Sign in with the email you use on the desktop, then scan the code from Settings →
            Account → Link new device on your computer, or type in your recovery phrase.
          </Text>

          <Text style={styles.paragraph}>
            It is a beta, so expect rough edges. Take a screenshot in TestFlight to send me
            feedback, or reply to this email. Android comes after the iPhone app, on the same core.
            You can follow both on the{' '}
            <Link href={roadmapUrl} style={styles.link}>
              roadmap
            </Link>
            .
          </Text>

          <Spacer />

          <Heading as="h2" style={styles.h2}>
            The Desktop App Is Moving to Tauri
          </Heading>

          <Text style={styles.paragraph}>
            Over the next month to month and a half, the desktop app moves from Electron to Tauri.
            Memrynote on macOS, Windows and Linux will run on Tauri after that.
          </Text>

          <Text style={styles.paragraph}>Three reasons:</Text>

          <Text style={styles.paragraph}>
            <strong>A smaller app.</strong> Electron ships its own copy of Chromium with every app.
            Tauri uses the web view your system already has, so the download gets smaller and the
            app should use less memory.
          </Text>

          <Text style={styles.paragraph}>
            <strong>One core with the iPhone app.</strong> The iPhone app already runs sync,
            encryption and storage on a Rust core. The desktop app moves onto the same core, so a
            fix or a feature there reaches both.
          </Text>

          <Text style={styles.paragraph}>
            <strong>A faster start.</strong> A lighter shell should open faster. I will measure it
            before I say how much.
          </Text>

          <Text style={styles.paragraph}>
            <strong>What changes for you meanwhile:</strong> the Electron app you use today keeps
            working. For the length of the move it only gets bug fixes, no new features, because the
            work goes into the move. New features come back once Tauri is the desktop app. I will
            write again when there is a Tauri build to try.
          </Text>

          <Spacer />

          <Text style={styles.paragraph}>
            For everything else, see the{' '}
            <Link href={releaseNotesUrl} style={styles.link}>
              full release notes
            </Link>{' '}
            or the{' '}
            <Link href={docsUrl} style={styles.link}>
              docs
            </Link>
            .
          </Text>

          <Text style={styles.paragraph}>
            One last thing: <strong>please reply to this email.</strong> It is not a no-reply
            address. Every reply lands in my inbox and I answer all of them myself. Bugs from the
            iPhone beta, questions about the move, things you hate: all of it helps.
          </Text>

          <Text style={styles.paragraph}>Thanks for being early.</Text>

          <Hr style={styles.divider} />

          <EmailFooter campaign={campaign} logoUrl={logoUrl} unsubscribeUrl={unsubscribeUrl} />
        </Container>
      </Body>
    </Html>
  )
}

function Spacer(): ReactNode {
  return (
    <Text style={styles.paragraph}>
      <br />
    </Text>
  )
}

function Media({
  url,
  alt,
  label,
  hint
}: {
  url: string
  alt: string
  label: string
  hint: string
}): ReactNode {
  if (url) {
    // Outlook on Windows ignores CSS widths and would draw these 2x images at full size;
    // the attribute pins them to the 560 px content column.
    return <Img src={url} alt={alt} width="560" style={styles.mediaImage} />
  }

  return (
    <Text style={styles.mediaNote}>
      <strong>↓ {label}</strong>
      <br />
      {hint}
    </Text>
  )
}

TestflightTauriEmail.PreviewProps = defaultProps

export default TestflightTauriEmail

const systemFont =
  "-apple-system, system-ui, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif"

const accent = '#ff671a'

const styles = {
  body: {
    margin: 0,
    backgroundColor: '#ffffff',
    fontFamily: systemFont,
    fontStyle: 'normal',
    fontWeight: 400,
    fontSize: '13px',
    lineHeight: '20px',
    color: '#222222'
  },
  container: {
    width: '100%',
    maxWidth: '600px',
    margin: '0 auto',
    padding: '32px 20px',
    backgroundColor: '#ffffff'
  },
  logoLink: {
    display: 'inline-block',
    textDecoration: 'none'
  },
  headerIcon: {
    display: 'block',
    outline: 'none',
    border: 'none',
    textDecoration: 'none',
    borderRadius: '8px'
  },
  divider: {
    width: '100%',
    margin: '0 0 13px',
    border: 'none',
    borderTop: '2px solid #eaeaea'
  },
  paragraph: {
    margin: 0,
    padding: '7px 0',
    color: '#222222',
    fontSize: '13px',
    fontWeight: 400,
    lineHeight: '20px'
  },
  h2: {
    margin: 0,
    padding: '5px 0 0',
    color: '#222222',
    fontSize: '23px',
    fontWeight: 600,
    lineHeight: '34px'
  },
  h3: {
    margin: 0,
    padding: '5px 0 0',
    color: '#222222',
    fontSize: '18px',
    fontWeight: 600,
    lineHeight: '24px'
  },
  link: {
    color: accent,
    fontWeight: 400,
    textDecoration: 'underline'
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
    fontSize: '15px',
    fontWeight: 600,
    lineHeight: '20px',
    textAlign: 'center',
    textDecoration: 'none'
  },
  mediaImage: {
    display: 'block',
    outline: 'none',
    border: 'none',
    textDecoration: 'none',
    width: '100%',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '8px'
  },
  mediaNote: {
    margin: 0,
    padding: '7px 0',
    color: '#888888',
    fontSize: '12px',
    fontWeight: 400,
    lineHeight: '18px'
  }
} satisfies Record<string, CSSProperties>
