import metascraper from 'metascraper'
import metascraperAuthor from 'metascraper-author'
import metascraperDate from 'metascraper-date'
import metascraperDescription from 'metascraper-description'
import metascraperImage from 'metascraper-image'
import metascraperLogo from 'metascraper-logo'
import metascraperPublisher from 'metascraper-publisher'
import metascraperTitle from 'metascraper-title'
import metascraperUrl from 'metascraper-url'

const scraper = metascraper([
  metascraperAuthor(),
  metascraperDate(),
  metascraperDescription(),
  metascraperImage(),
  metascraperLogo(),
  metascraperPublisher(),
  metascraperTitle(),
  metascraperUrl()
])

const URL_TO_TEST =
  process.argv[2] ||
  'https://eksisozluk.com/23-mart-2026-donald-trump-aciklamalari--8085786?day=2026-03-23'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function test() {
  console.log(`\n--- Testing: ${URL_TO_TEST} ---\n`)

  try {
    const response = await fetch(URL_TO_TEST, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    })

    console.log(`HTTP Status: ${response.status} ${response.statusText}`)
    console.log(`Content-Type: ${response.headers.get('content-type')}`)

    const html = await response.text()
    console.log(`HTML length: ${html.length} chars\n`)

    const metadata = await scraper({ html, url: URL_TO_TEST })

    console.log('=== Metascraper Result ===')
    for (const [key, value] of Object.entries(metadata)) {
      const display = value ? String(value).slice(0, 120) : '(null)'
      console.log(`  ${key}: ${display}`)
    }
    console.log('')

    // Also check raw OG tags for comparison
    console.log('=== Raw OG Tags (from HTML) ===')
    const ogTags = html.matchAll(/<meta\s+property="og:(\w+)"\s+content="([^"]*?)"/g)
    for (const match of ogTags) {
      console.log(`  og:${match[1]}: ${match[2].slice(0, 120)}`)
    }

    const twitterTags = html.matchAll(/<meta\s+name="twitter:(\w+)"\s+content="([^"]*?)"/g)
    for (const match of twitterTags) {
      console.log(`  twitter:${match[1]}: ${match[2].slice(0, 120)}`)
    }

    const descTag = html.match(/<meta\s+name="description"\s+content="([^"]*?)"/i)
    if (descTag) console.log(`  meta description: ${descTag[1].slice(0, 120)}`)

    const titleTag = html.match(/<title>([^<]*)<\/title>/i)
    if (titleTag) console.log(`  <title>: ${titleTag[1].slice(0, 120)}`)

    console.log('')
  } catch (err) {
    console.error('FAILED:', err.message)
    if (err.cause) console.error('Cause:', err.cause)
  }
}

test()
