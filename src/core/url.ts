/**
 * Small URL string helpers, kept regex-free where the input comes from
 * configuration (CodeQL js/polynomial-redos flags `/\/+$/` on such input).
 */

const SLASH = 0x2f;

/** Remove every trailing "/" (e.g. "https://x.dev//" -> "https://x.dev"). Linear time. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH) end--;
  return value.slice(0, end);
}
