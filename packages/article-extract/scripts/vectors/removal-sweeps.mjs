// Boundary sweeps: each page holds a rule's input at the number it compares against, one page
// per value, so a rule off by one shows as a difference between neighbours.
import { H1, byline, pad, page, plain, prose, sweep } from './removal-pages.mjs'

export const sweepCases = [
  ...sweep('sweep-dup-title-words', [2, 3, 15, 16], (n) =>
    page(`<div>${plain(n)}</div>${H1}${prose(4)}`, { title: plain(n) })
  ),
  ...sweep('sweep-timezone-position', [299, 300, 301], (k) =>
    page(`${pad(k)}<p>Current time in</p>${prose(3)}`)
  ),
  ...sweep('sweep-date-header-words', [9, 10, 11], (n) =>
    page(`<div>March 4 ${plain(n - 2)}</div>${H1}${prose(4)}`)
  ),
  ...sweep('sweep-badge-words', [4, 5, 6], (n) =>
    page(
      `<div><a href="/c"><img src="i.png"></a><a href="/c">${plain(n)}</a></div>${H1}${prose(4)}`
    )
  ),
  ...sweep('sweep-badge-link-ratio', [7, 8, 9], (n) =>
    page(
      `<div><img src="i.png"><a href="/c">${'a'.repeat(n)}</a>${'b'.repeat(10 - n)}</div>${H1}${prose(4)}`
    )
  ),
  ...sweep('sweep-read-time-words', [4, 5, 6], (n) =>
    page(
      `<p>${['Estimated', 'reading', 'time', '8', 'min', 'read'].slice(6 - n).join(' ')}</p>${H1}${prose(4)}`
    )
  ),
  ...sweep('sweep-author-date-words', [9, 10, 11], (n) =>
    page(
      `<span>Jane March 4 ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon'].slice(0, n - 3).join(' ')}</span>${H1}${prose(4)}`
    )
  ),
  ...sweep('sweep-author-name-words', [3, 4, 5], (n) =>
    page(
      `<span>${['Aa', 'Bb', 'Cc', 'Dd', 'Ee'].slice(0, n).join(' ')} March 4</span>${H1}${prose(4)}`
    )
  ),
  ...sweep('sweep-standalone-date-words', [4, 5, 6], (n) =>
    page(
      `<span>March 4 ${['Mon', 'Tue', 'Wed', 'Thu'].slice(0, n - 2).join(' ')}</span>${H1}${prose(4)}`
    )
  ),
  ...sweep('sweep-boundary-time-position', [200, 201], (k) =>
    page(`${pad(k)}<p><time>Zq</time></p>${pad(260)}`)
  ),
  ...sweep('sweep-boundary-time-distance', [200, 201], (m) =>
    page(`${pad(260)}<p><time>Zq</time></p>${pad(m)}`)
  ),
  ...sweep('sweep-metadata-list-position', [500, 501], (k) =>
    page(`${pad(k)}<ul><li>aa</li><li>bb</li></ul>${pad(560)}`)
  ),
  ...sweep('sweep-metadata-list-distance', [500, 501], (m) =>
    page(`${pad(560)}<ul><li>aa</li><li>bb</li></ul>${pad(m)}`)
  ),
  ...sweep('sweep-metadata-list-item-words', [8, 9], (n) =>
    page(`${prose(3)}<ul><li>${plain(n)}</li><li>x</li></ul>${prose(1)}`)
  ),
  ...sweep('sweep-metadata-list-total-words', [30, 31], (n) =>
    page(
      `${prose(3)}<ul><li> ${plain(8)} </li><li> ${plain(8)} </li><li> ${plain(8)} </li><li> ${plain(n - 24)} </li></ul>${prose(1)}`
    )
  ),
  ...sweep('sweep-metadata-list-items', [8, 9], (n) =>
    page(`${prose(3)}<ul>${'<li>aa</li>'.repeat(n)}</ul>${prose(1)}`)
  ),
  ...sweep('sweep-hero-prose-words', [29, 30], (n) =>
    page(
      `<div><h1> The Long Road Home </h1><time datetime="2024-03-04"> Mar 4 </time><p> ${plain(n)} </p></div>${prose(4)}`
    )
  ),
  ...sweep('sweep-audio-container-words', [25, 26], (n) =>
    page(`<div><p>${plain(n)}</p><audio src="a.mp3"></audio></div>${H1}${prose(3)}`)
  ),
  ...sweep('sweep-promo-link-words', [25, 26], (n) =>
    page(`<a href="/e"><div>${plain(n)}</div></a>${H1}${prose(3)}`)
  ),
  ...sweep('sweep-eyebrow-words', [5, 6, 7], (n) => page(`<div>${plain(n)}</div>${H1}${prose(3)}`)),
  ...sweep('sweep-eyebrow-length', [40, 41], (n) =>
    page(`<div>${'a'.repeat(n)}</div>${H1}${prose(3)}`)
  ),
  ...sweep('sweep-toc-position', [30, 31], (a) =>
    page(
      `${H1}<p>${'a'.repeat(a)}</p><ul><li><a href="#x">x</a></li><li><a href="#y">y</a></li><li><a href="#z">z</a></li></ul><p>${'b'.repeat(100 - a - 3)}</p>`
    )
  ),
  ...sweep('sweep-toc-anchor-ratio', [3, 4, 5], (n) =>
    page(
      `${H1}<ul>${'<li><a href="#a">x</a></li>'.repeat(n)}${'<li><a href="/o">o</a></li>'.repeat(5 - n)}</ul>${prose(3)}`
    )
  ),
  ...sweep('sweep-section-breadcrumb-words', [10, 11], (n) =>
    page(`<div><a href="/blog/">${plain(n)}</a></div>${H1}${prose(3)}`)
  ),
  ...sweep('sweep-thin-trailing-total', [300, 301], (total) =>
    page(`<h1> x </h1><p> ${plain(total - 10)} </p><div><h3> Join </h3><p> ${plain(8)} </p></div>`)
  ),
  ...sweep('sweep-thin-trailing-child-words', [24, 25, 26], (n) =>
    page(`<h1> x </h1><p> ${plain(380)} </p><div><h3> Join </h3><p> ${plain(n - 1)} </p></div>`)
  ),
  ...sweep('sweep-thin-trailing-ratio', [320, 321], (total) =>
    page(
      `<h1> x </h1><p> ${plain(total - 49)} </p><div><h3> Join </h3><p> ${plain(23)} </p></div><div><h3> Join </h3><p> ${plain(23)} </p></div>`
    )
  ),
  ...sweep('sweep-boilerplate-words', [49, 50, 51], (n) =>
    page(`${H1}${prose(10)}<div><p>Originally published on ${plain(n - 3)}</p></div><p>tail</p>`)
  ),
  ...sweep('sweep-boilerplate-position', [198, 199, 200, 201], (k) =>
    page(`<div><p>${'a'.repeat(k)}</p><div><p>Loading...</p></div><p>tail text</p></div>`)
  ),
  ...sweep('sweep-related-heading-position', [499, 500, 501], (k) =>
    page(
      `<div><p>${'a'.repeat(k)}</p><section><div><h2>Related posts</h2></div></section><p>after</p></div>`
    )
  ),
  ...sweep('sweep-related-intro-words', [20, 21], (n) =>
    page(`${H1}${prose(3)}<p>For more on ${plain(n - 3)}</p>`)
  ),
  ...sweep('sweep-related-cards-position', [499, 500, 501], (k) =>
    page(
      `<p>${'a'.repeat(k)}</p><section><div><div><img src="1.jpg"><h3>Alpha one</h3></div><div><img src="2.jpg"><h3>Beta two</h3></div></div></section><p>tail</p>`
    )
  ),
  ...sweep('sweep-related-cards-ratio', [2, 3, 4], (n) =>
    page(
      `${prose(14)}<section><div>${'<div><img src="1.jpg"><h3>Alpha one</h3></div>'.repeat(n)}${'<div><span>plain card</span></div>'.repeat(4 - n + (n === 2 ? 1 : 0))}</div></section><p>tail</p>`
    )
  ),
  ...sweep('sweep-newsletter-words', [59, 60, 61], (n) =>
    page(`${H1}${prose(5)}<div><p>Subscribe to our newsletter ${plain(n - 4)}</p></div><p>tail</p>`)
  ),
  ...sweep('sweep-newsletter-list-words', [29, 30, 31], (n) =>
    page(
      `${H1}${prose(5)}<ul><li>Subscribe newsletter ${plain(n - 2)}</li><li>x</li></ul><p>tail</p>`
    )
  ),
  ...sweep('sweep-newsletter-gap', [38, 39, 40, 41, 42], (n) =>
    page(`${H1}${prose(5)}<div>Subscribe ${'a'.repeat(n)} newsletter</div><p>tail</p>`)
  ),
  ...sweep('sweep-newsletter-wrapper-words', [61, 62], (m) =>
    page(
      `${H1}${prose(5)}<section><div> Subscribe to our newsletter ${plain(42)} </div><p> ${plain(m)} </p></section><p> tail </p>`
    )
  ),
  ...sweep('sweep-author-contact-words', [39, 40, 41], (n) =>
    page(`${H1}${prose(5)}<div><p> Contact </p><p> ${plain(n - 2)} </p><p> a@b.co </p></div>`)
  ),
  ...sweep('sweep-author-contact-distance', [299, 300, 301], (m) =>
    page(`${H1}${prose(5)}<div><p> Contact </p><p> a@b.co </p></div>${pad(m)}`)
  ),
  ...sweep('sweep-share-widget-words', [14, 15, 16], (n) =>
    page(`${H1}${prose(5)}<div><div><p> Share </p></div><p> ${plain(n - 1)} </p></div>`)
  ),
  ...sweep('sweep-social-counter-distance', [199, 200, 201], (m) =>
    page(`${H1}${prose(5)}<p>9 Likes</p>${pad(m)}`)
  ),
  ...sweep('sweep-tag-block-words', [9, 10, 11], (n) =>
    page(`${H1}${prose(5)}<div><a href="/t/a">${plain(n)}</a></div>`)
  ),
  ...sweep('sweep-tag-block-distance', [299, 300, 301], (m) =>
    page(`${H1}${prose(5)}<div><a href="/t/a">Features</a></div>${pad(m)}`)
  ),
  ...sweep('sweep-tag-block-link-ratio', [7, 8, 9], (n) =>
    page(`${H1}${prose(5)}<div><a href="/t/a">${'a'.repeat(n)}</a>${'b'.repeat(10 - n)}</div>`)
  ),
  ...sweep('sweep-external-list-items', [1, 2, 3], (n) =>
    page(
      `${H1}${prose(4)}<h2>Picks</h2><ul>${'<li><a href="https://shop.example.net/a">Product</a></li>'.repeat(n)}</ul>`
    )
  ),
  ...sweep('sweep-external-list-link-ratio', [5, 6, 7], (n) =>
    page(
      `${H1}${prose(4)}<h2>Picks</h2><ul><li><a href="https://x.net/a">${'a'.repeat(n)}</a>${'b'.repeat(10 - n)}</li><li><a href="https://x.net/b">ccccc</a></li></ul>`
    )
  ),
  ...sweep('sweep-related-posts-ratio', [5, 6, 7], (n) =>
    page(
      `${H1}${prose(4)}<section><p><a href="/a">${'a'.repeat(n)}</a>${'b'.repeat(10 - n)}</p><p><a href="/b">${'a'.repeat(n)}</a>${'b'.repeat(10 - n)}</p></section>`
    )
  ),
  ...sweep('sweep-prose-paragraph-words', [5, 6], (n) =>
    page(
      `<h1> x </h1><p> ${plain(380)} </p><h3> Join </h3><p> ${plain(n)} </p><p> ${plain(n)} </p>`
    )
  ),
  ...sweep('sweep-score-prose-blocks', [29, 30, 31], (n) =>
    page(`${prose(3)}<div><p>Share ${plain(n - 1)}</p><p>x</p></div>`)
  ),
  ...sweep('sweep-score-long-text', [99, 100, 101], (n) =>
    page(`${prose(3)}<div>Share ${plain(n - 1)}</div>`)
  ),
  ...sweep('sweep-score-prose-words', [9, 10], (n) =>
    page(`${prose(3)}<div>Share ${plain(n - 2)} end.</div>`)
  ),
  ...sweep('sweep-score-prose-links', [1, 2], (n) =>
    page(`${prose(3)}<div>Share ${plain(17)} end. ${'<a href="/x">a</a> '.repeat(n)}</div>`)
  ),
  ...sweep('sweep-score-nav-heading-words', [198, 199, 200], (n) =>
    page(`${prose(3)}<div><h2> Related articles </h2> ${plain(n - 2)} </div>`)
  ),
  ...sweep('sweep-score-nav-heading-links', [40, 41], (n) =>
    page(
      `${prose(3)}<div><h2>Related articles</h2>${'<a href="/x">a</a> '.repeat(n)}${plain(198 - n)}</div>`
    )
  ),
  ...sweep('sweep-score-nav-heading-large', [999, 1000], (n) =>
    page(
      `${prose(3)}<div><h2> Related articles </h2> ${'<a href="/x">a</a> '.repeat(300)}${plain(n - 302)} </div>`
    )
  ),
  ...sweep('sweep-score-card-grid-prose', [59, 60], (n) =>
    page(
      `${prose(3)}<div><h3> a </h3><h3> b </h3><h3> c </h3><img src="1.jpg"><img src="2.jpg"><span> ${plain(n)} </span></div>`
    )
  ),
  ...sweep('sweep-score-card-grid-words', [499, 500], (n) =>
    page(
      `${prose(3)}<div><h3> ${plain(165)} </h3><h3> ${plain(165)} </h3><h3> ${plain(165)} </h3><img src="1.jpg"><img src="2.jpg"><span> ${plain(n - 495)} </span></div>`
    )
  ),
  ...sweep('sweep-score-social-words', [79, 80], (n) =>
    page(`${prose(3)}<div>${plain(n - 1)} <a href="https://twitter.com/jane">j</a></div>`)
  ),
  ...sweep('sweep-score-byline-words', [14, 15], (n) =>
    page(`${prose(3)}<div>By Jane March 4 ${plain(n - 4)}</div>`)
  ),
  ...sweep('sweep-score-link-density', [5, 6], (k) =>
    page(`${prose(3)}<div>${'<a href="/x">a</a> '.repeat(k)}${plain(10 - k)}</div>`)
  ),
  ...sweep('sweep-score-list-links', [3, 4], (k) =>
    page(
      `${prose(3)}<div><ul><li>${plain(20)}</li></ul>${'<a href="/x">a</a> '.repeat(k)}${plain(60)}</div>`
    )
  ),
  ...sweep('sweep-score-commas', [0, 1, 2], (k) =>
    page(`${prose(3)}<div>Share this ${plain(5)}${','.repeat(k)}${' share'.repeat(0)}</div>`)
  ),
  ...sweep('sweep-small-image-size', [31, 32, 33, 34], (n) =>
    page(`${prose(3)}<img src="s.png" width="${n}" height="${n}">`)
  ),
  ...sweep('sweep-metadata-block-length', [298, 299, 300, 301], (n) =>
    page(`<h1>The Long Road Home</h1><div>March 24, 2026 ${'a'.repeat(n - 15)}</div>${prose(3)}`, {
      head: byline
    })
  )
]
