/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push("hashconnect", "@hashgraph/sdk");
    } else {
      // Disable code splitting entirely for client.
      // Vercel's CDN intermittently fails to serve separate chunks
      // (ChunkLoadError on the 2.2MB hashconnect chunk), breaking wallet
      // connection. A single bundle is larger but always loads reliably.
      config.optimization.splitChunks = false;
      config.optimization.runtimeChunk = false;
    }
    return config;
  },
};
module.exports = nextConfig;
