import { CapacitorConfig } from '@capacitor/cli';

// =============================================================================
// capacitor.config.ts — KaraokeParty Android app
// =============================================================================
// v1 -- Bundled local dist/ into the app at build time (no server.url).
//   Problem discovered: every Android build permanently freezes whatever
//   the website looked like at that exact moment. Deploying changes to
//   karaokeparty.in (e.g. redesigning/removing the Leaderboard page) had
//   ZERO effect on any AAB already built or being tested -- the app was
//   never actually loading the live site, it was loading its own local
//   copy from https://localhost, baked in permanently by `npx cap sync`.
//   Confusing to test, and meant every content change required a full
//   rebuild + re-signing + re-submission just to show up in the app.
//
// v2 -- CURRENT: server.url points directly at the live site. The app now
//   ALWAYS loads whatever is currently deployed at karaokeparty.in, live,
//   every time it opens -- no more stale/frozen snapshots, no rebuild
//   needed for ordinary content or UI changes.
//
//   KNOWN TRADEOFF, accepted deliberately: Google Play's minimum
//   functionality policy scrutinises apps that are "just a WebView
//   pointed at a website." This app does have genuine native code (the
//   microphone permission handling in MainActivity.java is real
//   Android-native functionality, not JS), which is the usual defence
//   if this gets flagged during review -- but it's a real risk to be
//   aware of during Play Console submission, not a hypothetical one.
//
//   Also: the app now requires an internet connection to load anything
//   at all -- there's no offline access to a locally bundled UI anymore.
// =============================================================================

const config: CapacitorConfig = {
  appId: 'in.karaokeparty.app',
  appName: 'KaraokeParty',
  webDir: 'dist', // still required by Capacitor's tooling even though
                   // server.url below takes precedence for what actually loads
  server: {
    url: 'https://karaokeparty.in/?utm_source=android_app&utm_medium=app',
    androidScheme: 'https',
    // cleartext left false (default) -- karaokeparty.in is https-only
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
