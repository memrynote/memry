import Svg, { Path } from 'react-native-svg'

export interface GlyphProps {
  paths: readonly string[]
  colour: string
  size?: number
  /** Set on a mark that points somewhere, so RTL flips it with the layout. */
  mirrored?: boolean
}

export function Glyph({ paths, colour, size = 21, mirrored = false }: GlyphProps) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessible={false}
      style={mirrored ? { transform: [{ scaleX: -1 }] } : undefined}
    >
      {paths.map((d) => (
        <Path
          key={d}
          d={d}
          fill="none"
          stroke={colour}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  )
}
