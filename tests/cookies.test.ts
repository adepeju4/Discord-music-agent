import { describe, it, expect } from 'vitest';
import { filterToYouTube, isYouTubeDomain, summarizeCookies } from '../src/utils/cookies';

const line = (name: string, value = 'v', domain = '.youtube.com') =>
  [domain, 'TRUE', '/', 'TRUE', '1799999999', name, value].join('\t');

describe('summarizeCookies', () => {
  it('rejects a jar with only anonymous visitor cookies', () => {
    const jar = [
      '# Netscape HTTP Cookie File',
      line('VISITOR_INFO1_LIVE'),
      line('YSC'),
      line('PREF'),
    ].join('\n');
    const summary = summarizeCookies(jar);

    expect(summary.signedIn).toBe(false);
    expect(summary.loginCookies).toEqual([]);
    expect(summary.names).toEqual(['VISITOR_INFO1_LIVE', 'YSC', 'PREF']);
  });

  it('accepts a jar from a signed-in session', () => {
    const jar = [line('VISITOR_INFO1_LIVE'), line('SID'), line('__Secure-1PSID')].join('\n');
    const summary = summarizeCookies(jar);

    expect(summary.signedIn).toBe(true);
    expect(summary.loginCookies).toEqual(['SID', '__Secure-1PSID']);
  });

  it('ignores comments, blank lines and malformed rows', () => {
    const jar = ['# comment', '', '   ', 'not\ttab\tseparated', line('LOGIN_INFO')].join('\n');
    const summary = summarizeCookies(jar);

    expect(summary.names).toEqual(['LOGIN_INFO']);
    expect(summary.signedIn).toBe(true);
  });

  it('treats an empty file as not signed in', () => {
    expect(summarizeCookies('')).toEqual({
      names: [],
      loginCookies: [],
      signedIn: false,
      foreignDomains: [],
    });
  });

  it('reports cookies belonging to unrelated sites', () => {
    const jar = [
      line('SID'),
      line('NetflixId', 'v', '.netflix.com'),
      line('sessionKey', 'v', '.claude.ai'),
      line('at-main', 'v', '.amazon.com'),
    ].join('\n');

    expect(summarizeCookies(jar).foreignDomains).toEqual([
      'amazon.com',
      'claude.ai',
      'netflix.com',
    ]);
  });
});

describe('isYouTubeDomain', () => {
  it('accepts YouTube hosts, with or without a leading dot', () => {
    for (const d of ['.youtube.com', 'youtube.com', 'www.youtube.com', 'music.youtube.com']) {
      expect(isYouTubeDomain(d)).toBe(true);
    }
  });

  it('rejects google.com, whose session cookies carry Gmail and Drive access', () => {
    for (const d of ['.google.com', 'accounts.google.com', 'mail.google.com']) {
      expect(isYouTubeDomain(d)).toBe(false);
    }
  });

  it('rejects everything else, including lookalikes', () => {
    for (const d of [
      '.netflix.com',
      'claude.ai',
      '.amazon.com',
      'notyoutube.com',
      'youtube.com.evil.net',
    ]) {
      expect(isYouTubeDomain(d)).toBe(false);
    }
  });
});

describe('filterToYouTube', () => {
  it('keeps only YouTube cookies and drops the rest', () => {
    const jar = [
      '# Netscape HTTP Cookie File',
      line('SID'),
      line('NetflixId', 'v', '.netflix.com'),
      line('SAPISID'),
      line('GMAIL_AT', 'v', '.google.com'),
      line('sessionKey', 'v', '.claude.ai'),
    ].join('\n');

    const { kept, dropped } = filterToYouTube(jar);
    expect(dropped).toBe(3);

    const summary = summarizeCookies(kept);
    expect(summary.names).toEqual(['SID', 'SAPISID']);
    expect(summary.foreignDomains).toEqual([]);
    expect(summary.signedIn).toBe(true);
    // The header comment survives so the file stays a valid cookie jar.
    expect(kept).toContain('# Netscape HTTP Cookie File');
  });

  it('leaves an already-clean jar untouched', () => {
    const jar = [line('SID'), line('LOGIN_INFO')].join('\n');
    const { kept, dropped } = filterToYouTube(jar);
    expect(dropped).toBe(0);
    expect(kept).toBe(jar);
  });
});
