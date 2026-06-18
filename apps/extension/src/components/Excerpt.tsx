export function Excerpt({ text }: { text: string }) {
  if (!text.trim()) return null
  return (
    <p className="line-clamp-3 font-sans text-[13.5px] leading-relaxed text-text-secondary">
      {text}
    </p>
  )
}
