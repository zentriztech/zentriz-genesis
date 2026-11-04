/** `href` seguro para links vindos do servidor (PR no GitHub etc.): só `https://`. `javascript:`, `data:`, `http:` e relativos viram `null` (Y-18). */
export function safeHttpsUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https:\/\/[^\s]+$/i.test(url.trim()) ? url.trim() : null;
}
