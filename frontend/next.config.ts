import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Lets several dev servers run side by side without sharing a build dir.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  transpilePackages: [
    '@univerjs/core',
    '@univerjs/design',
    '@univerjs/docs',
    '@univerjs/docs-ui',
    '@univerjs/engine-formula',
    '@univerjs/engine-render',
    '@univerjs/facade',
    '@univerjs/presets',
    '@univerjs/preset-sheets-core',
    '@univerjs/rpc',
    '@univerjs/sheets',
    '@univerjs/sheets-formula',
    '@univerjs/sheets-formula-ui',
    '@univerjs/sheets-numfmt',
    '@univerjs/sheets-numfmt-ui',
    '@univerjs/sheets-ui',
    '@univerjs/sheets-filter',
    '@univerjs/sheets-filter-ui',
    '@univerjs/sheets-sort',
    '@univerjs/sheets-sort-ui',
    '@univerjs/ui',
  ],
}

export default nextConfig
