import url from "@rollup/plugin-url";
import resolve from "@rollup/plugin-node-resolve";

export default {
  plugins: [
    resolve({
      browser: true,
      preferBuiltins: false,
    }),
    url({
      include: [/node_modules\/quickpix\/.+(?:resize-worker|pipeline-worker)\.js$/],
      limit: 0,
      emitFiles: true,
      fileName: "[name]-[hash][extname]",
      publicPath: "/assets/",
    }),
  ],
};
