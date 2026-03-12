export const esbuildConfig = {
  entryPoints: ["src/index.js"],
  bundle: true,
  platform: "browser",
  format: "esm",
  outdir: "dist",
  // Keep worker JS files emit as assets so Worker() gets a URL
  loader: {
    ".js": "file",
    ".wasm": "file",
  },
  assetNames: "assets/[name]-[hash]",
  // In your own project, pass plugin/CLI flags here.
};

export const esbuildCli = "esbuild src/index.js --bundle --platform=browser --format=esm --outdir=dist --loader:.js=file";
