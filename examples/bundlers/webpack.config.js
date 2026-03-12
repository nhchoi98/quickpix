module.exports = {
  output: {
    publicPath: "/",
  },
  module: {
    rules: [
      {
        test: /node_modules\/quickpix\/.+(?:resize-worker|pipeline-worker)\.js$/,
        type: "asset/resource",
        generator: {
          filename: "assets/[name]-[hash][extname]",
        },
      },
    ],
  },
};
