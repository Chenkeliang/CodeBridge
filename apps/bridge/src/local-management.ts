/** The management surface belongs to the local OS user, not to arbitrary browser origins. */
export function isLocalManagementRequest(request: Request): boolean {
  const local = (host: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host.toLowerCase());
  const url = new URL(request.url);
  if (!local(url.hostname)) return false;
  const host = request.headers.get("host");
  try { if (host && !local(new URL(`http://${host}`).hostname)) return false; }
  catch { return false; }
  const origin = request.headers.get("origin");
  return (!origin || origin === url.origin) && request.headers.get("sec-fetch-site") !== "cross-site";
}
