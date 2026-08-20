export function revisionTail(value: string | null | undefined): string {
  if (!value) return "";
  const colon = value.lastIndexOf(":");
  const hex = colon >= 0 ? value.slice(colon + 1) : value;
  return hex.slice(-8);
}