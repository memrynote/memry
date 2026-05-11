import { Img, Section, Text } from '@react-email/components'

type InlineImageProps = {
  alt: string
  caption?: string
  src?: string
}

const styles = {
  wrapper: {
    margin: '20px 0'
  } as const,
  image: {
    width: '100%',
    height: 'auto',
    borderRadius: 8,
    border: '1px solid #e7e5e4',
    display: 'block'
  } as const,
  caption: {
    margin: '8px 0 0 0',
    fontSize: 13,
    color: '#71717a'
  } as const
}

export function InlineImage({ alt, caption, src }: InlineImageProps) {
  const placeholder = `https://placehold.co/1100x600/fafaf9/27272a?text=${encodeURIComponent(alt)}`
  return (
    <Section style={styles.wrapper}>
      <Img src={src ?? placeholder} alt={alt} style={styles.image} width="552" />
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </Section>
  )
}
