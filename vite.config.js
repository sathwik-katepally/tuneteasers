import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

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
  plugins: [preact(), cloudflareBeacon(process.env.CF_WEB_ANALYTICS_TOKEN)],
});
