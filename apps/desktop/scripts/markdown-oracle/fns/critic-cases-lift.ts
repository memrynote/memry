/** Cases of `editor-schema/src/lift-images.ts`. */
import type { OracleCase } from '../cases-frontmatter'
import type { MarkdownSource } from '../cases-bn'
import { fnCase, indexed } from './critic-cases-parse'

const HTML: Record<string, string> = {
  empty: '',
  'no images': '<p>just text</p>',
  'image in text': '<p>a <img src="x.png" alt="x"> b</p>',
  'image only paragraph': '<p><img src="x.png"></p>',
  'two images only': '<p><img src="a"> <img src="b"></p>',
  'image at start': '<p><img src="x"> tail</p>',
  'image at end': '<p>head <img src="x"></p>',
  'image with spaces around': '<p>a   <img src="x">   b</p>',
  'image with tabs around': '<p>a\t<img src="x">\tb</p>',
  'adjacent text no space': '<p>a<img src="x">b</p>',
  'heading only image': '<h2><img src="x"></h2>',
  'heading image text': '<h3>t <img src="x"> u</h3>',
  'heading linked image': '<h2><a href="l"><img src="i" alt="ALT"></a></h2>',
  'linked image alt': '<p>see <a href="l"><img src="i" alt="ALT"></a> here</p>',
  'linked image href only': '<p>see <a href="l"><img src="i"></a> here</p>',
  'linked image empty alt': '<p>see <a href="l"><img src="i" alt=""></a> here</p>',
  'linked image no label': '<p>see <a class="c"><img src="i"></a> here</p>',
  'linked image whitespace inside': '<p>x <a href="l">\n <img src="i" alt="A">\u00A0</a> y</p>',
  'linked image only': '<p><a href="l"><img src="i" alt="A"></a></p>',
  'uppercase tags': '<P>a <IMG SRC="x"> b</P>',
  'uppercase link': '<p>a <A HREF="u"><IMG ALT="Z" SRC="x"></A> b</p>',
  'attribute with gt': '<p>a <img alt="a>b" src="x"> c</p>',
  'img lookalike': '<p>a <imgx src="x"> b</p>',
  'img dash': '<p>a <img-x src="x"> b</p>',
  nested: '<blockquote><p>a <img src="x"> b</p></blockquote>',
  'list item': '<ul><li><p>a <img src="x"> b</p></li></ul>',
  'comment hides': '<!-- <p>a <img src="x"> b</p> --><p>c</p>',
  'comment between': '<p>a <!-- c --> <img src="x"> b</p>',
  'unclosed comment': '<p>a <!-- <img src="x"> b</p>',
  'unclosed p': '<p>a <img src="x"> b',
  'void tags': '<p>a<br>b <img src="x"> <hr> c</p>',
  'p in p': '<p>a <p>b <img src="x"> c</p> d</p>',
  'two blocks': '<p>a <img src="1"> b</p><h1>c <img src="2"> d</h1>',
  'mixed tags': '<p>a <img src="1"> b</p><div>x</div><p>c</p>',
  'strong around image': '<p>a <strong><img src="x"></strong> b</p>',
  'em text': '<p><em>a</em> <img src="x"> <em>b</em></p>',
  'emoji and cjk': '<p>😀 <img src="x" alt="日本語"> 日本語</p>',
  'emoji linked': '<p>😀 <a href="https://例え.jp"><img src="i"></a> 😀</p>',
  'image multiline tag': '<p>a <img\n src="x"\n alt="y"> b</p>',
  'tag with newline': '<p\n>a <img src="x"> b</p\n>',
  'closing with attrs': '<p>a <img src="x"> b</p foo>',
  'nbsp whitespace': '<p>\u00A0<img src="x">\u00A0</p>',
  'only whitespace and image': '<p> \n <img src="x"> \n </p>',
  'text then lone link image': '<p>caption <a href="l"><img src="i"></a></p>',
  'two linked': '<p>a <a href="1"><img src="i" alt="x"></a> <a href="2"><img src="j"></a> b</p>',
  'a not link': '<p>a <abbr><img src="x"></abbr> b</p>',
  'a with newline attrs': '<p>a <A\nhref="u"><img alt="L" src="i"></A> b</p>',
  'heading six': '<h6>a <img src="x"></h6>',
  'heading seven': '<h7>a <img src="x"></h7>',
  'span wrapped': '<p><span>a</span> <img src="x"></p>',
  'comment inner only image': '<p><!-- c --><img src="x"></p>'
}

export function liftCases(external: MarkdownSource[]): OracleCase[] {
  const cases = indexed(HTML).map(([slug, html]) =>
    fnCase('lift-images', slug, 'liftImages.liftImagesOutOfTextBlocks', html)
  )
  // The caller lifts only markdown that mentions an image.
  external.forEach((source, i) => {
    if (!/!\[|<img\b/i.test(source.markdown)) return
    cases.push(
      fnCase(
        'lift-images-src',
        `src-${String(i).padStart(4, '0')}`,
        'liftImages.liftFromMarkdown',
        source.markdown
      )
    )
  })
  const extra: Record<string, string> = {
    caption: 'Caption ![i](u.png)\n',
    'heading image': '## [![i](u.png)](https://example.com)\n',
    'image between text': 'a ![x](1.png) b ![y](2.png) c\n',
    'image only': '![x](1.png)\n',
    'linked image': 'see [![alt](i.png)](https://e.com) now\n',
    'emoji caption': '😀 ![日本語](u.png) 😀\n',
    'html img': 'text <img src="x.png" alt="y"> more\n',
    'title and spaces': 'a   ![x](u.png "t")   b\n'
  }
  indexed(extra).forEach(([slug, md]) => {
    cases.push(fnCase('lift-images-md', slug, 'liftImages.liftFromMarkdown', md))
  })
  return cases
}
