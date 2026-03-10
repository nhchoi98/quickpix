import url from "@rollup/plugin-url";

export default {
  plugins: [
    url({
      include: [/node_modules\/quickpix\/.+worker\.js$/],
      limit: 0,
      emitFiles: true,
      fileName: "[name]-[hash][extname]",
    }),
  ],
};
