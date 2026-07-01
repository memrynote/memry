import type { CSSProperties, ReactElement } from 'react'
import { Body, Container, Head, Hr, Html, Link, Preview, Text } from 'react-email'
import {
  feedbackContent,
  gettingStartedContent,
  launchWeekContent,
  localFirstAiContent,
  migrationGuideContent,
  scatteredWorkflowContent,
  syncConversionContent,
  useCasesContent,
  welcomeContent,
  workflowContent
} from './waitlist-program-content'
import { trackedMemryUrl } from './tracking-links'
import type { WaitlistCampaignId } from './tracking-links'

export type WaitlistProgramEmailContent = {
  subject: string
  preview: string
  intro: readonly string[]
  listTitle?: string
  bullets?: readonly string[]
  outro?: readonly string[]
  campaign: WaitlistCampaignId
}

export type WaitlistProgramEmailProps = {
  firstName?: string
  replyToEmail?: string
  unsubscribeUrl?: string
}

const defaultProps = {
  firstName: '',
  replyToEmail: 'kaan@memrynote.com',
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<WaitlistProgramEmailProps>

type EmailComponent = {
  (props: WaitlistProgramEmailProps): ReactElement
  PreviewProps?: WaitlistProgramEmailProps
}

function createWaitlistProgramEmail(content: WaitlistProgramEmailContent): EmailComponent {
  const Email: EmailComponent = (props) => {
    const { firstName, replyToEmail, unsubscribeUrl } = {
      ...defaultProps,
      ...props
    }

    const greeting = firstName ? `Hey ${firstName},` : 'Hey,'

    return (
      <Html lang="en">
        <Head />
        <Preview>{content.preview}</Preview>
        <Body style={styles.body}>
          <Container style={styles.container}>
            <Text style={styles.paragraph}>{greeting}</Text>

            {content.intro.map((paragraph) => (
              <Text key={paragraph} style={styles.paragraph}>
                {paragraph}
              </Text>
            ))}

            {content.listTitle ? <Text style={styles.paragraph}>{content.listTitle}</Text> : null}

            {content.bullets?.map((bullet) => (
              <Text key={bullet} style={styles.listItem}>
                — {bullet}
              </Text>
            ))}

            {content.outro?.map((paragraph, index) => (
              <Text
                key={paragraph}
                style={
                  index === 0 && content.bullets ? styles.paragraphAfterList : styles.paragraph
                }
              >
                {paragraph}
              </Text>
            ))}

            <Text style={styles.signature}>
              — Kaan
              <br />
              <Link
                href={trackedMemryUrl('/', content.campaign, 'signature')}
                style={styles.signatureLink}
              >
                memrynote.com
              </Link>
            </Text>

            <Hr style={styles.hr} />

            <Text style={styles.footer}>
              You&apos;re getting this because you joined the Memrynote waitlist. Reply to me at{' '}
              <Link href={`mailto:${replyToEmail}`} style={styles.footerLink}>
                {replyToEmail}
              </Link>{' '}
              or{' '}
              <Link href={unsubscribeUrl} style={styles.footerLink}>
                unsubscribe
              </Link>
              .
            </Text>
          </Container>
        </Body>
      </Html>
    )
  }

  Email.PreviewProps = defaultProps
  return Email
}

export const WaitlistScatteredWorkflowEmail = createWaitlistProgramEmail(scatteredWorkflowContent)
export const WaitlistWorkflowEmail = createWaitlistProgramEmail(workflowContent)
export const WaitlistLocalFirstAiEmail = createWaitlistProgramEmail(localFirstAiContent)
export const WaitlistLaunchWeekEmail = createWaitlistProgramEmail(launchWeekContent)
export const WaitlistGettingStartedEmail = createWaitlistProgramEmail(gettingStartedContent)
export const WaitlistUseCasesEmail = createWaitlistProgramEmail(useCasesContent)
export const WaitlistFeedbackEmail = createWaitlistProgramEmail(feedbackContent)
export const WaitlistWelcomeEmail = createWaitlistProgramEmail(welcomeContent)
export const WaitlistMigrationGuideEmail = createWaitlistProgramEmail(migrationGuideContent)
export const WaitlistSyncConversionEmail = createWaitlistProgramEmail(syncConversionContent)

const styles = {
  body: {
    margin: 0,
    backgroundColor: '#ffffff',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif',
    color: '#1a1a1a'
  },
  container: {
    width: '100%',
    maxWidth: '560px',
    margin: '0 auto',
    padding: '40px 24px'
  },
  paragraph: {
    margin: '0 0 20px',
    color: '#1a1a1a',
    fontSize: '16px',
    lineHeight: '26px'
  },
  listItem: {
    margin: '0 0 6px',
    color: '#1a1a1a',
    fontSize: '16px',
    lineHeight: '26px'
  },
  paragraphAfterList: {
    margin: '20px 0',
    color: '#1a1a1a',
    fontSize: '16px',
    lineHeight: '26px'
  },
  signature: {
    margin: '8px 0 36px',
    color: '#1a1a1a',
    fontSize: '16px',
    lineHeight: '26px'
  },
  signatureLink: {
    color: '#888888',
    fontSize: '15px',
    textDecoration: 'underline'
  },
  hr: {
    margin: '0 0 16px',
    border: 'none',
    borderTop: '1px solid #ebebeb'
  },
  footer: {
    margin: 0,
    color: '#888888',
    fontSize: '12px',
    lineHeight: '18px'
  },
  footerLink: {
    color: '#555555',
    textDecoration: 'underline'
  }
} satisfies Record<string, CSSProperties>
