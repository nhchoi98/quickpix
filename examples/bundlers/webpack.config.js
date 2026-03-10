module.exports = {
  module: {
    rules: [
      {
        test: /node_modules\/quickpix\/.+(?:resize-worker|pipeline-worker)\.js$/,
        type: "asset/resource",
      },
    ],
  },
};
