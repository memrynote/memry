import { Img, Section, Text } from '@react-email/components'

type HeroImageProps = {
  alt: string
  caption?: string
  src?: string
}

const styles = {
  wrapper: {
    margin: '24px 0 32px 0'
  } as const,
  image: {
    width: '100%',
    height: 'auto',
    borderRadius: 12,
    border: '1px solid #e7e5e4',
    display: 'block'
  } as const,
  caption: {
    margin: '10px 0 0 0',
    fontSize: 13,
    color: '#71717a',
    fontStyle: 'italic'
  } as const
}

export function HeroImage({ alt, caption, src }: HeroImageProps) {
  const placeholder = `https://placehold.co/1200x680/fafaf9/27272a?text=${encodeURIComponent(
    `Hero: ${alt}`
  )}`
  return (
    <Section style={styles.wrapper}>
      <Img src={src ?? placeholder} alt={alt} style={styles.image} width="552" />
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </Section>
  )
}
