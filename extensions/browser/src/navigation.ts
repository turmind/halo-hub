/** Address entry is navigation only, never a search query. */
export function addressUrl(value: string): string | undefined {
  const text = value.trim()
  if (!text || text.length > 8192) return
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(text) && !/^(?:localhost|[\w-]+(?:\.[\w-]+)+):\d+(?:[/?#]|$)/i.test(text)
  try {
    const url = new URL(hasScheme ? text : `https://${text}`)
    // Chromium accepts percent-encoded spaces in hosts that Node rejects; keep address validation consistent.
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\s%]/.test(url.hostname)) return url.href
  } catch { /* Invalid addresses stay in the viewer for correction. */ }
}
