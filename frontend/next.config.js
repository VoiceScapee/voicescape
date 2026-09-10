/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push("hashconnect", "@hashgraph/sdk");
    } else {
      // Split the large hashconnect chunk into smaller pieces (<500KB).
      // Vercel's CDN fails to serve the single 2.2MB chunk (ChunkLoadError).
      // Smaller chunks are more likely to upload/serve successfully.
      config.optimization.splitChunks.cacheGroups.walletSplit = {
        test: /[\\/]node_modules[\\/](hashconnect|@walletconnect|@hashgraph)[\\/]/,
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
