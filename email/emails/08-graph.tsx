import { Heading, Text } from '@react-email/components'
import { Eyebrow } from '../components/Eyebrow'
import { Footer } from '../components/Footer'
import { HeroImage } from '../components/HeroImage'
import { InlineImage } from '../components/InlineImage'
import { Layout } from '../components/Layout'
import { Signoff } from '../components/Signoff'
import { TOTAL_EMAILS, WAITLIST_FIRST_NAME } from '../components/constants'
import { body, greeting, heading, sectionHeading, subhead } from '../components/styles'

export const subject = 'See how your notes connect'
export const preview = "A map of the work you've already done."

export default function Email08Graph() {
  return (
    <Layout preview={preview}>
      <Eyebrow label="GRAPH" index={8} total={TOTAL_EMAILS} />
      <Heading style={heading}>See how your notes connect.</Heading>
      <Text style={subhead}>A map of the work you have already done.</Text>

      <Text style={greeting}>Hi {WAITLIST_FIRST_NAME},</Text>

      <Text style={body}>
        Memry has a graph view. Every note is a node. Every link, mention, tag, and project
        membership is an edge. Open the graph and you see the shape of what you have written.
      </Text>

      <HeroImage
        alt="Graph view showing a network of connected notes"
        caption="The graph is one map for everything you have written."
      />

      <Heading as="h2" style={sectionHeading}>
        Why it is there
      </Heading>
      <Text style={body}>
        We did not want a graph for its own sake. We wanted a way to find the note we wrote three
        months ago about a topic we vaguely remember. The graph is fast at that. You spot a cluster,
        click into it, and the right note is one hop away.
      </Text>

      <InlineImage alt="Graph zoomed in on a cluster of related notes" />

      <Heading as="h2" style={sectionHeading}>
        How to use it
      </Heading>
      <Text style={body}>
        Filter by tag. Filter by date range. Filter by project. Drag a node to rearrange. Hover a
        node to preview the note inline. Click a node to open it. Use it for orientation, not
        decoration.
      </Text>

      <Text style={body}>
        It renders with WebGL and runs at sixty frames per second on graphs with thousands of nodes.
        We tested it on our own vault, which now holds several thousand notes.
      </Text>

      <Signoff launchLine="Launching in 10 days." />
      <Footer />
    </Layout>
  )
}

Email08Graph.PreviewProps = {}
