// scripts/prerender-routes.mjs — runs after `vite build` (see package.json).
// =============================================================================
// GitHub Pages has no URL rewrites: a request for /leaderboard only works if
// a file exists there. The app now uses clean URLs (BrowserRouter), so this
// writes a copy of dist/index.html for every public page, each with its own
// <title>, description, canonical and social tags, so Google gets a real
// 200 page per route. The React app takes over in the browser as usual.
//
// Dynamic routes (/sing/:trackId, /party/:code/stage|queue) can't be listed
// ahead of time; dist/404.html (a noindex copy of the app) loads them for
// users. GitHub Pages serves that file with HTTP 404, so those per-song and
// per-party pages are intentionally not indexed.
//
// Keep ROUTES in sync with the <Route> list in src/App.tsx and with
// public/sitemap.xml (indexable pages only).
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SITE = "https://karaokeparty.in";
const DIST = "dist";

const ROUTES = [
  { path: "leaderboard", index: true,
    title: "Karaoke Leaderboard — Top Singers | KaraokeParty",
    description: "See the top karaoke singers and highest scores on KaraokeParty. Sing Hindi, Gujarati, Marathi, Tamil and more, and climb the leaderboard." },
  { path: "party/host", index: true,
    title: "Host a Karaoke Party at Home | KaraokeParty",
    description: "Start a karaoke party in seconds. Friends join from their phones with a code, queue Indian songs and compete on a live party leaderboard." },
  { path: "party/join", index: true,
    title: "Join a Karaoke Party | KaraokeParty",
    description: "Enter your party code to join a KaraokeParty stage, add songs to the queue and sing with friends." },
  { path: "privacy", index: true,
    title: "Privacy Policy | KaraokeParty",
    description: "How KaraokeParty handles your data, microphone access and singing scores." },
  // Real files so direct visits/bookmarks load with 200, but kept out of search.
  { path: "auth", index: false, title: "Sign in | KaraokeParty",
    description: "Sign in to KaraokeParty to save your scores." },
  { path: "history", index: false, title: "Your Singing History | KaraokeParty",
    description: "Your past KaraokeParty performances and scores." },
  { path: "profile", index: false, title: "Your Profile | KaraokeParty",
    description: "Your KaraokeParty profile." },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function replaceOnce(html, pattern, replacement, label) {
  const matches = html.match(new RegExp(pattern.source, "g"));
  if (!matches || matches.length !== 1) {
    throw new Error(`prerender-routes: expected exactly one ${label} in dist/index.html, found ${matches ? matches.length : 0}`);
  }
  return html.replace(pattern, replacement);
}

function render(base, { url, title, description, index }) {
  let html = base;
  const t = esc(title), d = esc(description);
  html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${t}</title>`, "<title>");
  html = replaceOnce(html, /<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${d}" />`, "meta description");
  html = replaceOnce(html, /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${t}" />`, "og:title");
  html = replaceOnce(html, /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${d}" />`, "og:description");
  html = replaceOnce(html, /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${url ?? `${SITE}/`}" />`, "og:url");
  html = replaceOnce(html, /<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${t}" />`, "twitter:title");
  html = replaceOnce(html, /<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${d}" />`, "twitter:description");
  if (url) {
    html = replaceOnce(html, /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />`, "canonical");
  } else {
    html = replaceOnce(html, /\s*<link rel="canonical" href="[^"]*" \/>/, "", "canonical");
  }
  if (!index) {
    html = replaceOnce(html, /<\/head>/, `    <meta name="robots" content="noindex" />\n  </head>`, "</head>");
  }
  return html;
}

const base = readFileSync(join(DIST, "index.html"), "utf8");

for (const r of ROUTES) {
  const dir = join(DIST, r.path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), render(base, { ...r, url: `${SITE}/${r.path}/` }));
  console.log(`prerender-routes: /${r.path}/ ${r.index ? "" : "(noindex)"}`);
}

// Dynamic routes and unknown paths.
writeFileSync(join(DIST, "404.html"), render(base, {
  url: null, index: false,
  title: "KaraokeParty — Sing in Hindi, Gujarati, Marathi, Tamil & More",
  description: "AI-powered karaoke for Indian songs.",
}));
console.log("prerender-routes: 404.html (noindex, serves /sing/..., /party/CODE/...)");
