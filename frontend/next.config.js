const { PHASE_DEVELOPMENT_SERVER } = require("next/constants");

function getDevelopmentPort() {
  const portFlagIndex = process.argv.findIndex(
    (argument) => argument === "-p" || argument === "--port",
  );
  const candidate =
    (portFlagIndex >= 0 ? process.argv[portFlagIndex + 1] : undefined)
    || process.env.PORT
    || "3000";

  return /^\d+$/.test(candidate) ? candidate : "3000";
}

/** @type {import('next').NextConfig} */
module.exports = (phase) => ({
  // Keep every dev port separate from production `.next` output. This avoids
  // an active dev server losing its client chunks when `next build` runs.
  distDir: process.env.PLANPILOT_NEXT_DIST_DIR
    || (phase === PHASE_DEVELOPMENT_SERVER
      ? `.next-dev-${getDevelopmentPort()}`
      : ".next"),
  output: "standalone",
  async rewrites() {
    const internalApiUrl = (process.env.API_URL || "http://localhost:8000").replace(/\/$/, "");
    return [
      { source: "/api/backend/:path*", destination: `${internalApiUrl}/:path*` },
      { source: "/auth/register", destination: "/register" },
      { source: "/auth/recover", destination: "/recover" },
    ];
  },
  async redirects() {
    return [
      { source: "/forgot-password", destination: "/auth/recover", permanent: false },
      { source: "/reset-password", destination: "/auth/recover", permanent: false },
      { source: "/onboarding/appearance", destination: "/onboarding", permanent: false },
    ];
  },
});
