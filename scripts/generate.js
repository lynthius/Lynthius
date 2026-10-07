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

const WAKATIME_API_KEY      = process.env.WAKATIME_API_KEY;

const SITE = 'https://tomaszprzyborowski.com';

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

  // user repos (public + private)
  while (true) {
    const batch = await ghFetch(
      `/user/repos?per_page=100&page=${page}&affiliation=owner&visibility=all`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos = repos.concat(batch.filter(r => !r.fork));
    if (batch.length < 100) break;
    page++;
  }

  // noo-ma org repos
  let orgPage = 1;
  while (true) {
    const batch = await ghFetch(
      `/orgs/noo-ma/repos?per_page=100&page=${orgPage}&type=all`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos = repos.concat(batch.filter(r => !r.fork && r.permissions?.push));
    if (batch.length < 100) break;
    orgPage++;
  }

  const langTotals = {};
  await Promise.all(
    repos.map(async repo => {
      const langs = await ghFetch(`/repos/${repo.full_name}/languages`);
      if (typeof langs !== 'object' || langs === null || langs.message) return;
      for (const [lang, bytes] of Object.entries(langs)) {
        langTotals[lang] = (langTotals[lang] || 0) + bytes;
      }
    })
  );

  // markup / stylesheets are noise in a language breakdown
  const EXCLUDED = new Set(['HTML', 'CSS', 'SCSS', 'Sass', 'Less', 'Stylus']);
  const counted = Object.entries(langTotals).filter(([lang]) => !EXCLUDED.has(lang));

  const total = counted.reduce((sum, [, bytes]) => sum + bytes, 0);
  return counted
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([lang, bytes]) => ({ lang, pct: (bytes / total) * 100 }));
}

async function ghGraphQL(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'readme-gen',
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function getActivity(weeks = 30) {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            weeks { contributionDays { contributionCount date } }
          }
        }
      }
    }
  `;

  try {
    const data = await ghGraphQL(query, { login: USERNAME });
    const cal = data?.data?.user?.contributionsCollection?.contributionCalendar;
    if (!cal?.weeks?.length) return null;

    const weekTotals = cal.weeks
      .slice(-weeks)
      .map(w => w.contributionDays.reduce((sum, d) => sum + d.contributionCount, 0));

    // streak counts back from today; an empty today has not broken it yet
    const days = cal.weeks
      .flatMap(w => w.contributionDays)
      .filter(d => new Date(d.date) <= new Date());

    let streak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i].contributionCount > 0) streak++;
      else if (i === days.length - 1) continue;
      else break;
    }

    return { weekTotals, streak, weeks: weekTotals.length };
  } catch (err) {
    console.warn('Activity fetch failed:', err.message);
    return null;
  }
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

// ─── Site ────────────────────────────────────────────────────────────────────

async function getSiteHealth(samples = 3) {
  const timings = [];
  let status = 0;

  for (let i = 0; i < samples; i++) {
    try {
      const t0 = Date.now();
      const res = await fetch(SITE, { redirect: 'follow' });
      timings.push(Date.now() - t0);
      status = res.status;
      await res.arrayBuffer();
    } catch (err) {
      console.warn('Site check failed:', err.message);
    }
  }

  if (!timings.length) return null;

  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];

  // bucketed to 10ms so run-to-run jitter does not churn the README
  return { ok: status >= 200 && status < 400, status, ttfb: Math.round(median / 10) * 10 };
}

// ─── README builder ───────────────────────────────────────────────────────────

function spark(values) {
  const CHARS = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 1);

  // log scale: one outlier week should not flatten every other week to ▁
  return values
    .map(v => {
      if (v === 0) return CHARS[0];
      const ratio = Math.log1p(v) / Math.log1p(max);
      return CHARS[Math.min(CHARS.length - 1, Math.max(1, Math.round(ratio * (CHARS.length - 1))))];
    })
    .join('');
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function bar(pct, width = 22) {
  const filled = Math.max(1, Math.round((pct / 100) * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function buildReadme({ topLangs, totalCommits, spotify, activity, site }) {
  const LABEL = 15;

  const spotifyLine = spotify
    ? `${spotify.artist} — ${spotify.track}`
    : `nothing in history`;

  const rows = [`${pad('commits', LABEL)}${totalCommits.toLocaleString('en-US')}`, ''];

  rows.push(
    topLangs.length
      ? topLangs
          .map(({ lang, pct }) => `${pad(lang, LABEL)}${bar(pct)}  ${pct.toFixed(1).padStart(5)}%`)
          .join('\n')
      : 'no language data'
  );

  if (activity) {
    rows.push(
      '',
      `${pad(`last ${activity.weeks}w`, LABEL)}${spark(activity.weekTotals)}`,
      `${pad('streak', LABEL)}${activity.streak} ${activity.streak === 1 ? 'day' : 'days'}`
    );
  }

  if (site?.ok) rows.push(`${pad('site', LABEL)}${site.ttfb}ms`);

  return `

**Tomasz** \`/ˈtɔ.maʂ/\`<br>
Shopify Engineer · AI Engineer<br>

AI Systems for Commerce.<br>
Shopify apps, backend systems, retrieval and agents in production.<br>
Currently building tools around e-commerce search and catalog data.<br>
Interested? Ping. Connect. Deploy.<br>

\`\`\`
${rows.join('\n')}
\`\`\`

\`core\` &nbsp; shopify · liquid · javascript · preact/react · node · graphql · webhooks · llm apis · mcp · gcp · cloud run · docker · polaris

\`advanced\` &nbsp; python (fastapi) · postgres + pgvector · retrieval (bm25 · embeddings · hybrid) · evals & ranking metrics

--

\`recently played\` &nbsp; ${spotifyLine}

--

\`more\` &nbsp; [tomaszprzyborowski.com](https://tomaszprzyborowski.com)
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching language stats...');
  const topLangs = await getLanguageStats();

  console.log('Fetching commit count...');
  const totalCommits = await getTotalCommits();

  console.log('Fetching contribution activity...');
  const activity = await getActivity();

  console.log('Fetching Spotify...');
  const spotify = await getSpotify();

  console.log('Checking site...');
  const site = await getSiteHealth();

  console.log('Building README...');
  const readme  = buildReadme({ topLangs, totalCommits, spotify, activity, site });
  const outPath = path.join(__dirname, '..', 'README.md');
  fs.writeFileSync(outPath, readme, 'utf-8');
  console.log(`Done → ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
