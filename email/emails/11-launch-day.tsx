import { Button, Column, Heading, Row, Section, Text } from '@react-email/components'
import { Eyebrow } from '../components/Eyebrow'
import { Footer } from '../components/Footer'
import { HeroImage } from '../components/HeroImage'
import { Layout } from '../components/Layout'
import { Signoff } from '../components/Signoff'
import { TOTAL_EMAILS, WAITLIST_FIRST_NAME } from '../components/constants'
import { body, greeting, heading, sectionHeading, subhead } from '../components/styles'

export const subject = 'Memry is here'
export const preview = 'The download is ready.'

const downloadButton = {
  display: 'block',
  width: '100%',
  padding: '14px 20px',
  borderRadius: 8,
  border: '1px solid #18181b',
  backgroundColor: '#18181b',
  color: '#fafaf9',
  fontSize: 15,
  fontWeight: 600,
  textDecoration: 'none',
  textAlign: 'center' as const
}

const downloadRow = {
  margin: '24px 0 8px 0'
}

const downloadCol = {
  paddingRight: 8,
  paddingLeft: 8,
  paddingTop: 4,
  paddingBottom: 4
}

export default function Email11LaunchDay() {
  return (
    <Layout preview={preview}>
      <Eyebrow label="LAUNCH DAY" index={11} total={TOTAL_EMAILS} />
      <Heading style={heading}>Memry is here.</Heading>
      <Text style={subhead}>Download for macOS, Windows, and Linux.</Text>

      <Text style={greeting}>Hi {WAITLIST_FIRST_NAME},</Text>

      <Text style={body}>
        Memry is live. You can download it now. Choose your operating system below. Setup takes
        about a minute.
      </Text>

      <HeroImage alt="Memry download page hero" caption="Download Memry from memry.app." />

      <Section style={downloadRow}>
        <Row>
          <Column style={downloadCol}>
            <Button href="https://memry.app/download/mac" style={downloadButton}>
              Download for macOS
            </Button>
          </Column>
        </Row>
        <Row>
          <Column style={downloadCol}>
            <Button href="https://memry.app/download/windows" style={downloadButton}>
              Download for Windows
            </Button>
          </Column>
        </Row>
        <Row>
          <Column style={downloadCol}>
            <Button href="https://memry.app/download/linux" style={downloadButton}>
              Download for Linux
            </Button>
          </Column>
        </Row>
      </Section>

      <Heading as="h2" style={sectionHeading}>
        What is in the box
      </Heading>
      <Text style={body}>
        Everything you have seen across these emails. Notes, tasks, journal, inbox, calendar,
        projects, AI agent, graph view, and offline-first sync. One install. One workspace.
      </Text>

      <Heading as="h2" style={sectionHeading}>
        Found a bug? Want a feature?
      </Heading>
      <Text style={body}>
        Reply to this email. We read everything. We answer most things within a day. The fastest way
        to shape the app right now is to tell us where it falls short.
      </Text>

      <Text style={body}>Thank you for waiting.</Text>

      <Signoff launchLine="Memry is yours from here." />
      <Footer />
    </Layout>
  )
}

Email11LaunchDay.PreviewProps = {}
