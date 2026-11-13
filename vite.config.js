import { defineConfig } from "vite";

// Cloudflare Web Analytics beacon, rendered only when the build has a site
// token (CI passes the CF_WEB_ANALYTICS_TOKEN repo variable; local builds
// have none and ship no beacon). The token is public by design: it is the
// same string any visitor can read out of the page.
function cloudflareBeacon(token) {
  return {
    name: "cloudflare-web-analytics",
    transformIndexHtml() {
      if (!token) return [];
      return [
        {
          tag: "script",
          attrs: {
            defer: true,
            src: "https://static.cloudflareinsights.com/beacon.min.js",
            "data-cf-beacon": JSON.stringify({ token }),
          },
          injectTo: "body",
        },
      ];
    },
  };
}

export default defineConfig({
  base: "./", // relative asset URLs so the build works at any Pages path
  plugins: [cloudflareBeacon(process.env.CF_WEB_ANALYTICS_TOKEN)],
  define: {
    // Error reporting is built in only when the build has a Sentry DSN (CI
    // passes the SENTRY_DSN repo variable; local builds have none and never
    // load the SDK). Like the beacon token, a DSN is public by design.
    __SENTRY_DSN__: JSON.stringify(process.env.SENTRY_DSN || ""),
    __BUILD_SHA__: JSON.stringify(process.env.GITHUB_SHA || "local"),
    // Sentry's own flags: they drop its debug logging and tracing code from the bundle.
    __SENTRY_DEBUG__: false,
    __SENTRY_TRACING__: false,
  },
});
