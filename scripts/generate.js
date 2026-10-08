#!/usr/bin/env node
// scripts/generate.js
// Fetches GitHub activity data and writes README.md to the repo root.

const fs   = require('fs');
const path = require('path');

const USERNAME              = 'lynthius';
const GH_TOKEN              = process.env.GH_TOKEN;

const WAKATIME_API_KEY      = process.env.WAKATIME_API_KEY;

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

// Commit search sees private repos the token can reach, which is why the commit
// counter above is accurate. contributionsCollection does not, so activity is
// derived from the same endpoint instead.
async function getActivity(weeks = 12) {
  const DAY = 86400000;
  const iso = ms => new Date(ms).toISOString().slice(0, 10);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = today.getTime() - (weeks * 7 - 1) * DAY;

  try {
    const perDay = {};
    let fetched = 0;

    // search caps out at 1000 results; newest first, so recent weeks stay exact
    for (let page = 1; page <= 10; page++) {
      const q = `author:${USERNAME} committer-date:>=${iso(start)}`;
      const data = await ghFetch(
        `/search/commits?q=${encodeURIComponent(q)}&sort=committer-date&order=desc&per_page=100&page=${page}`,
        'application/vnd.github.cloak-preview+json'
      );

      const items = data?.items;
      if (!Array.isArray(items)) {
        console.warn('Commit search stopped:', data?.message || 'unexpected response');
        break;
      }
      if (!items.length) break;

      for (const it of items) {
        const d = it?.commit?.committer?.date || it?.commit?.author?.date;
        if (d) perDay[d.slice(0, 10)] = (perDay[d.slice(0, 10)] || 0) + 1;
      }
      fetched += items.length;
      if (items.length < 100) break;
    }

    if (!fetched) return null;

    // search truncates at 1000 results, so only render weeks that came back whole
    const dates = Object.keys(perDay).sort();
    let span = weeks;
    if (fetched >= 1000) {
      const safeFrom = Date.parse(`${dates[0]}T00:00:00Z`) + DAY;
      const fullDays = Math.floor((today.getTime() - safeFrom) / DAY) + 1;
      span = Math.max(1, Math.min(weeks, Math.floor(fullDays / 7)));
    }
    const from = today.getTime() - (span * 7 - 1) * DAY;

    const weekTotals = Array.from({ length: span }, (_, w) => {
      let sum = 0;
      for (let d = 0; d < 7; d++) sum += perDay[iso(from + (w * 7 + d) * DAY)] || 0;
      return sum;
    });

    // counts back from today; an empty today has not broken the streak yet
    let streak = 0;
    for (let d = 0; d < weeks * 7; d++) {
      if (perDay[iso(today.getTime() - d * DAY)]) streak++;
      else if (d > 0) break;
    }

    console.log(`Activity: ${fetched} commits over ${span}w, streak ${streak}d`);
    return { weekTotals, streak, weeks: span };
  } catch (err) {
    console.warn('Activity fetch failed:', err.message);
    return null;
  }
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

function buildReadme({ topLangs, totalCommits, activity }) {
  const LABEL = 15;

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

  return `

**Tomasz** \`/ˈtɔ.maʂ/\`<br>
AI Systems for Commerce. <img src="https://media.giphy.com/media/elasZ4ibZDAE8/200w.gif" height="60" align="absmiddle" alt="robot"><br>

Shopify apps, backend systems, retrieval and agents in production.<br>
Currently building tools <img src="https://media.giphy.com/media/3ohjV0PbaTBNw42YO4/200w.gif" height="60" align="absmiddle" alt="computer"> around e-commerce search <img src="https://media.giphy.com/media/l2QDMn3ozS3SWcheo/200w.gif" height="60" align="absmiddle" alt="game"> and catalog data.<br>
Interested? Ping. Connect. Deploy. <img src="https://media.giphy.com/media/ilqP03ohzeIJZGnnpe/200w.gif" height="60" align="absmiddle" alt="silent film"><br>

\`\`\`
${rows.join('\n')}
\`\`\`

\`core\` &nbsp; shopify · liquid · javascript · preact/react · node · graphql · webhooks · llm apis · mcp · gcp · cloud run · docker · polaris

\`going deeper\` &nbsp; python (fastapi) · postgres + pgvector · retrieval (bm25 · embeddings · hybrid) · evals & ranking metrics

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

  console.log('Building README...');
  const readme  = buildReadme({ topLangs, totalCommits, activity });
  const outPath = path.join(__dirname, '..', 'README.md');
  fs.writeFileSync(outPath, readme, 'utf-8');
  console.log(`Done → ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
