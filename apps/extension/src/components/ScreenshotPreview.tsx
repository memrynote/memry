export function ScreenshotPreview({ dataUrl }: { dataUrl: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface">
      <img
        src={dataUrl}
        alt="Page screenshot"
        className="max-h-48 w-full object-contain object-top"
      />
    </div>
  )
}
