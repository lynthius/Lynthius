#!/usr/bin/env node
// scripts/generate.js
// Fetches GitHub + Spotify data and writes user.svg to the repo root.

const fs   = require('fs');
const path = require('path');

const USERNAME             = 'lynthius';
const GH_TOKEN             = process.env.GH_TOKEN;
const SPOTIFY_CLIENT_ID    = process.env.SPOTIFY_CLIENT_ID;
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
  // Uses the commit search API — counts all public commits by the user.
  const data = await ghFetch(
    `/search/commits?q=author:${USERNAME}&per_page=1`,
    'application/vnd.github.cloak-preview+json'
  );
  return data.total_count || 0;
}

async function getLanguageStats() {
  // Paginate through all non-fork repos.
  let repos = [];
  let page  = 1;
  while (true) {
    const batch = await ghFetch(
      `/users/${USERNAME}/repos?per_page=100&page=${page}&type=owner`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos = repos.concat(batch.filter(r => !r.fork));
    if (batch.length < 100) break;
    page++;
  }

  // Aggregate byte counts per language across all repos in parallel.
  const langTotals = {};
  await Promise.all(
    repos.map(async repo => {
      const langs = await ghFetch(`/repos/${USERNAME}/${repo.name}/languages`);
      if (typeof langs !== 'object') return;
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
    return null; // Secrets not configured — skip section.
  }
  try {
    const token = await spotifyToken();

    // Check currently playing first.
    const nowRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (nowRes.status === 200) {
      const data = await nowRes.json();
      if (data?.item) {
        return { track: data.item.name, artist: data.item.artists[0].name, playing: data.is_playing };
      }
    }

    // Fallback: last played track.
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

// ─── SVG builder ──────────────────────────────────────────────────────────────

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function bar(pct, width = 22) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSVG({ topLangs, repoCount, totalCommits, spotify }) {
  const GREEN  = '#39d353';
  const WHITE  = '#e6edf3';
  const DIM    = '#8b949e';
  const W      = 800;
  const FS     = 13;
  const LH     = 21;
  const PAD    = 20;

  const g = t => ({ t, c: GREEN });
  const w = t => ({ t, c: WHITE });
  const d = t => ({ t, c: DIM });
  const _ = { t: '', c: WHITE };

  const spotifyLine = spotify
    ? `  ⏸  ${esc(spotify.artist)} — ${esc(spotify.track)}`
    : '  ⏸  nothing in history';

  const lines = [
    g('$ whoami'),
    _,
    w('  Tomasz Przyborowski  [/ˈtɔ.maʂ/]'),
    d('  Fullstack Shopify Developer'),
    d('  Theme dev (Dawn, Horizon)  ·  Custom Apps'),
    d('  Poland  ·  coffee-driven'),
    _,
    g('$ cat about.txt'),
    _,
    { t: '  I build Shopify stores that are engineered, not assembled.', c: WHITE },
    { t: '  Aesthetic and fast e-commerce experiences. Clean code. Smart structure.', c: DIM },
    { t: '  No unnecessary apps. If it needs to be fast, it\'s fast.', c: DIM },
    { t: '  If it needs to scale, it scales. If it\'s weird — we figure it out.', c: DIM },
    { t: '  Interested? Ping. Connect. Deploy.', c: DIM },
    _,
    g('$ cat stack.txt'),
    _,
    d('  // core'),
    w('  shopify  ·  liquid  ·  javascript  ·  graphql  ·  node'),
    w('  vite  ·  gulp  ·  gcp  ·  webflow  ·  hexo'),
    _,
    d('  // exploring'),
    w('  typescript  ·  react  ·  python  ·  vercel'),
    _,
    g('$ git log --oneline | wc -l'),
    d(`  → ${totalCommits} commits  ·  ${repoCount} repositories`),
    _,
    g('$ cat languages.txt'),
    _,
    ...topLangs.map(({ lang, pct }) =>
      w(`  ${pad(lang, 14)} ${bar(pct)}  ${String(pct).padStart(3)}%`)
    ),
    _,
    g('$ spotify-cli --recently-played'),
    { t: spotifyLine, c: WHITE },
    _,
    g('$ █'),
  ];

  const H    = PAD + lines.length * LH + PAD;
  const rows = lines
    .map((line, i) => {
      const y = PAD + i * LH;
      return `  <text x="16" y="${y}" fill="${line.c}" xml:space="preserve">${esc(line.t)}</text>`;
    })
    .join('\n');

  return `<svg width="100%" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <style>
    text {
      font-family: ui-monospace, 'Cascadia Code', 'Fira Code', Menlo, Consolas, 'Courier New', monospace;
      font-size: ${FS}px;
    }
  </style>

  <!-- Content -->
${rows}
</svg>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching GitHub language stats...');
  const { topLangs, repoCount } = await getLanguageStats();

  console.log('Fetching commit count...');
  const totalCommits = await getTotalCommits();

  console.log('Fetching Spotify...');
  const spotify = await getSpotify();

  console.log('Building SVG...');
  const svg     = buildSVG({ topLangs, repoCount, totalCommits, spotify });
  const outPath = path.join(__dirname, '..', 'user.svg');
  fs.writeFileSync(outPath, svg, 'utf-8');
  console.log(`Done → ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
