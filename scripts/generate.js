#!/usr/bin/env node
// scripts/generate.js
// Fetches GitHub + Spotify data and writes README.md to the repo root.

const fs   = require('fs');
const path = require('path');

const USERNAME              = 'lynthius';
const GH_TOKEN              = process.env.GH_TOKEN;
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;

// ─── GitHub ───────────────────────────────────────────────────────────────────

async function ghFetch(endpoint, accept = 'application/vnd.github+json') {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: accept,
      'User-Agent': 'readme-gen',
    },
  });
  return res.json();
}

async function getTotalCommits() {
  const data = await ghFetch(
    `/search/commits?q=author:${USERNAME}&per_page=1`,
    'application/vnd.github.cloak-preview+json'
  );
  return data.total_count || 0;
}

async function getLanguageStats() {
  let repos = [];
  let page  = 1;
  while (true) {
    const batch = await ghFetch(
      `/user/repos?per_page=100&page=${page}&affiliation=owner,organization_member&visibility=all`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos = repos.concat(batch.filter(r => !r.fork));
    if (batch.length < 100) break;
    page++;
  }

  const langTotals = {};
  await Promise.all(
    repos.map(async repo => {
      const langs = await ghFetch(`/repos/${USERNAME}/${repo.name}/languages`);
      if (typeof langs !== 'object' || langs === null || langs.message) return;
      for (const [lang, bytes] of Object.entries(langs)) {
        langTotals[lang] = (langTotals[lang] || 0) + bytes;
      }
    })
  );

  const EXCLUDE  = new Set(['HTML', 'CSS', 'SCSS', 'Sass', 'Less', 'Stylus']);
  const total    = Object.values(langTotals).reduce((a, b) => a + b, 0);
  const topLangs = Object.entries(langTotals)
    .filter(([lang]) => !EXCLUDE.has(lang))
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([lang, bytes]) => ({
      lang,
      pct: Math.round((bytes / total) * 100),
    }));

  console.log('Top langs:', topLangs.map(l => l.lang).join(', '));
  return { topLangs, repoCount: repos.length };
}

// ─── Spotify ──────────────────────────────────────────────────────────────────

async function spotifyToken() {
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res   = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=refresh_token&refresh_token=${SPOTIFY_REFRESH_TOKEN}`,
  });
  const data = await res.json();
  return data.access_token;
}

async function getSpotify() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
    return null;
  }
  try {
    const token = await spotifyToken();

    const nowRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (nowRes.status === 200) {
      const data = await nowRes.json();
      if (data?.item) {
        return { track: data.item.name, artist: data.item.artists[0].name, playing: data.is_playing };
      }
    }

    const recentRes = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (recentRes.ok) {
      const data  = await recentRes.json();
      const track = data.items?.[0]?.track;
      if (track) return { track: track.name, artist: track.artists[0].name, playing: false };
    }
  } catch (err) {
    console.warn('Spotify fetch failed:', err.message);
  }
  return null;
}

// ─── README builder ───────────────────────────────────────────────────────────

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function bar(pct, width = 22) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function buildReadme({ topLangs, repoCount, totalCommits, spotify }) {
  const spotifyIcon = spotify?.playing ? '▶' : '⏸';
  const spotifyLine = spotify
    ? `${spotifyIcon} ${spotify.artist} — ${spotify.track}`
    : `${spotifyIcon} nothing in history`;

  const langLines = topLangs.length
    ? topLangs.map(({ lang, pct }) => `\`${lang}\` ${bar(pct)} ${pct}%`).join('  \n')
    : '_no data_';

  return `\`\`\`bash
$ ./profile.sh
\`\`\`

**Tomasz Przyborowski** \`/ˈtɔ.maʂ/\`
Fullstack Shopify Developer · Theme dev (Dawn, Horizon) · Poland · coffee-driven

I build Shopify stores that are engineered, not assembled. Aesthetic and fast e-commerce experiences. Clean code. Smart structure. No unnecessary apps. If it needs to be fast, it's fast. If it needs to scale, it scales. If it's weird — we figure it out. Interested? Ping. Connect. Deploy.

---

\`core\` &nbsp; shopify · liquid · javascript · graphql · node · vite · gulp · gcp · webflow · hexo

\`learning\` &nbsp; typescript · react · python · vercel

---

\`commits\` ${totalCommits} &nbsp; \`repositories\` ${repoCount}

${langLines}

---

\`recently played\` &nbsp; ${spotifyLine}
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching GitHub language stats...');
  const { topLangs, repoCount } = await getLanguageStats();

  console.log('Fetching commit count...');
  const totalCommits = await getTotalCommits();

  console.log('Fetching Spotify...');
  const spotify = await getSpotify();

  console.log('Building README...');
  const readme  = buildReadme({ topLangs, repoCount, totalCommits, spotify });
  const outPath = path.join(__dirname, '..', 'README.md');
  fs.writeFileSync(outPath, readme, 'utf-8');
  console.log(`Done → ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
