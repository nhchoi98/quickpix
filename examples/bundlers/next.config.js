/** @type {import('next').NextConfig} */
module.exports = {
  transpilePackages: ["quickpix"],
  webpack(config) {
    config.module.rules.push({
      test: /node_modules\/quickpix\/.+(?:resize-worker|pipeline-worker)\.js$/,
      type: "asset/resource",
    });
    return config;
  },
};
