/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push("hashconnect", "@hashgraph/sdk");
    } else {
      // Split the large wallet chunk into smaller pieces (<500KB).
      // Vercel's CDN fails to serve the single 2.2MB chunk (ChunkLoadError).
      // (Fully defensive: optimization structure may not exist in dev mode.)
      config.optimization = config.optimization || {};
      config.optimization.splitChunks = config.optimization.splitChunks || {};
      config.optimization.splitChunks.cacheGroups =
        config.optimization.splitChunks.cacheGroups || {};
      config.optimization.splitChunks.cacheGroups.walletSplit = {
        test: /[\\/]node_modules[\\/](hashconnect|@walletconnect|@hashgraph|@hiero-ledger)[\\/]/,
        name: "wallet-chunk",
        chunks: "all",
        enforce: true,
        maxSize: 500000, // 500KB max per chunk
      };
    }
    return config;
  },
};
module.exports = nextConfig;
