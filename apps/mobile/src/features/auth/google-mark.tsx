import Svg, { Path } from 'react-native-svg'

/**
 * Google's brand mark. Its colours are fixed by Google's guidelines, so it is
 * the one glyph in the app that ignores the theme.
 */
export function GoogleMark({ size = 18 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18">
      <Path
        d="M17.6 9.2c0-.6 0-1.2-.2-1.7H9v3.3h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5"
        fill="#4285F4"
      />
      <Path
        d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.3c-.8.6-1.9.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18"
        fill="#34A853"
      />
      <Path d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8z" fill="#FBBC05" />
      <Path
        d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6"
        fill="#EA4335"
      />
    </Svg>
  )
}
