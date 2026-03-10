export const esbuildConfig = {
  entryPoints: ["src/index.js"],
  bundle: true,
  platform: "browser",
  outdir: "dist",
  format: "esm",
  // Keep QuickPix worker imports in `?url` form.
  // If your environment resolves only file URLs from `?url`,
  // add the loader/plugin configuration that matches your stack.
};

