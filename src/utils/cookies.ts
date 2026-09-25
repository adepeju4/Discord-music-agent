/**
 * Helpers for Netscape-format cookie files (what yt-dlp reads and writes).
 *
 * A cookie jar exported from a browser where nobody is signed in still looks
 * healthy — it has visitor cookies and a plausible size — but proves nothing to
 * YouTube. On a home connection that mostly goes unnoticed; from a datacenter IP
 * it means every request gets the "confirm you're not a bot" challenge.
 */

/** Any one of these means the export came from a signed-in session. */
export const LOGIN_COOKIE_NAMES = [
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  'LOGIN_INFO',
];

/** Domains yt-dlp actually needs to authenticate with YouTube. */
export const YOUTUBE_COOKIE_DOMAINS = ['youtube.com', 'google.com', 'googlevideo.com'];

export function isYouTubeDomain(domain: string, allowed = YOUTUBE_COOKIE_DOMAINS): boolean {
  const host = domain.replace(/^\./, '').toLowerCase();
  return allowed.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * `--cookies-from-browser` exports the whole browser jar, so the file arrives
 * holding live sessions for every site you are signed into. Only the YouTube
 * and Google entries are useful here, and the file is about to be copied to a
 * server, so everything else is stripped.
 */
export function filterToYouTube(contents: string): { kept: string; dropped: number } {
  const out: string[] = [];
  let dropped = 0;

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    const fields = trimmed.split('\t');
    if (fields.length < 7) {
      out.push(line);
      continue;
    }
    if (isYouTubeDomain(fields[0])) out.push(line);
    else dropped++;
  }

  return { kept: out.join('\n'), dropped };
}

export interface CookieSummary {
  names: string[];
  loginCookies: string[];
  signedIn: boolean;
  /** Domains unrelated to YouTube — these should never reach a server. */
  foreignDomains: string[];
}

export function summarizeCookies(contents: string): CookieSummary {
  const names: string[] = [];
  const foreignDomains = new Set<string>();
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // domain, includeSubdomains, path, secure, expiry, name, value
    const fields = trimmed.split('\t');
    if (fields.length < 7) continue;
    const name = fields[5];
    if (name) names.push(name);
    if (!isYouTubeDomain(fields[0])) foreignDomains.add(fields[0].replace(/^\./, ''));
  }

  const loginCookies = LOGIN_COOKIE_NAMES.filter((n) => names.includes(n));
  return {
    names,
    loginCookies,
    signedIn: loginCookies.length > 0,
    foreignDomains: [...foreignDomains].sort(),
  };
}
