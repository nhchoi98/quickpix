const wasmModules = new Map();
const wasmLoadPromises = new Map();

const isNodeEnvironment = () =>
  typeof process !== "undefined" &&
  Boolean(process?.versions?.node) &&
  typeof process.versions.node === "string";

export function clearWasmCache() {
  wasmLoadPromises.clear();
  wasmModules.clear();
}

export async function loadWasmModule(wasmPath) {
  if (wasmModules.has(wasmPath)) {
    return wasmModules.get(wasmPath);
  }

  if (!wasmLoadPromises.has(wasmPath)) {
    wasmLoadPromises.set(
      wasmPath,
      import(wasmPath).then(async (mod) => {
        if (!mod.default) {
          return mod;
        }

        if (isNodeEnvironment()) {
          const wasmBase = new URL(wasmPath);
          const wasmBinaryUrl = new URL("./quickpix_wasm_bg.wasm", wasmBase);
          const { readFile } = await import("node:fs/promises");
          const { fileURLToPath } = await import("node:url");

          const wasmBytes = await readFile(fileURLToPath(wasmBinaryUrl));
          await mod.default({ module_or_path: wasmBytes });
          return mod;
        }

        await mod.default();
        return mod;
      })
    );
  }

  const mod = await wasmLoadPromises.get(wasmPath);
  wasmModules.set(wasmPath, mod);
  return mod;
}
