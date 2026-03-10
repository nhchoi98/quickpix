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

export function resolveWorkerURLs(candidates, baseURL) {
  const urls = [];
  for (const candidate of candidates || []) {
    try {
      urls.push(new URL(candidate, baseURL).toString());
    } catch {
      // ignore
    }
  }
  return urls;
}

export function normalizeWorkerSources(input, defaultSources = []) {
  if (!input) {
    return defaultSources.slice();
  }

  const raw = Array.isArray(input) ? input : [input];
  const out = [];

  for (const item of raw) {
    if (!item) continue;
    if (typeof item === "function") {
      out.push(item);
      continue;
    }
    out.push(item instanceof URL ? item.toString() : String(item));
  }

  return Array.from(new Set(out));
}
