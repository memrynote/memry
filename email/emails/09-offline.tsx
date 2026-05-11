import { Heading, Text } from '@react-email/components'
import { Eyebrow } from '../components/Eyebrow'
import { Footer } from '../components/Footer'
import { HeroImage } from '../components/HeroImage'
import { InlineImage } from '../components/InlineImage'
import { Layout } from '../components/Layout'
import { Signoff } from '../components/Signoff'
import { TOTAL_EMAILS, WAITLIST_FIRST_NAME } from '../components/constants'
import { body, greeting, heading, sectionHeading, subhead } from '../components/styles'

export const subject = 'Built to work offline first'
export const preview = 'Local first. Sync is an afterthought.'

export default function Email09Offline() {
  return (
    <Layout preview={preview}>
      <Eyebrow label="OFFLINE" index={9} total={TOTAL_EMAILS} />
      <Heading style={heading}>Built to work offline first.</Heading>
      <Text style={subhead}>Sync is something that happens later.</Text>

      <Text style={greeting}>Hi {WAITLIST_FIRST_NAME},</Text>

      <Text style={body}>
        Memry opens, reads, and writes to a local SQLite database on your machine. Nothing in the
        app waits on the network. Open it on a plane. Open it in a dead zone. The whole app works.
      </Text>

      <HeroImage
        alt="Memry running in airplane mode with full UI working"
        caption="No network. Full app. The local database does the work."
      />

      <Text style={body}>
        When you reconnect, Memry pushes what you wrote and pulls what other devices wrote. It does
        this quietly. No banner. No modal. No loading state in the UI.
      </Text>

      <Heading as="h2" style={sectionHeading}>
        Why we chose this
      </Heading>
      <Text style={body}>
        The apps we relied on for years stopped working when our internet went down. We lost notes
        during outages. We watched the cursor stall in the middle of a sentence. So we wrote Memry
        the other way around. Local first. Network second. Sync as a feature, not a dependency.
      </Text>

      <InlineImage alt="Sync indicator in a calm idle state" />

      <Text style={body}>
        If you uninstall the server tomorrow, Memry still opens. Your files are yours. Your database
        is yours. You can export everything as plain markdown and walk away.
      </Text>

      <Signoff launchLine="Launching in 7 days." />
      <Footer />
    </Layout>
  )
}

Email09Offline.PreviewProps = {}
