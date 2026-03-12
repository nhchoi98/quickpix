export function warnMainThreadFallback(message, detail) {
  if (typeof console === "undefined" || typeof console.warn !== "function") {
    return;
  }

  if (detail) {
    console.warn(`[quickpix] ${message}`, detail);
  } else {
    console.warn(`[quickpix] ${message}`);
  }
}

function toWorkerSource(item) {
  if (typeof item === "function") {
    return item;
  }
  return item instanceof URL ? item.toString() : String(item);
}

function coerceWorkerSources(input) {
  const values = Array.isArray(input) ? input : [input];
  return values
    .filter(Boolean)
    .map(toWorkerSource)
    .filter((value) => typeof value === "function" || typeof value === "string");
}

export function normalizeWorkerSources(input, defaultSources = []) {
  if (input === undefined || input === null) {
    return defaultSources.slice();
  }

  const sources = coerceWorkerSources(input);
  if (!sources.length) {
    return [];
  }

  const out = [];
  const seen = new Set();

  for (const item of sources) {
    if (typeof item === "function") {
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
      continue;
    }

    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }

  return out;
}
