importScripts("/sw-assets.js");

const CACHE_PREFIX = "eduri-shell-";
const manifest = self.__EDURI_PRECACHE_MANIFEST__;
if (
  !manifest
  || typeof manifest.version !== "string"
  || !Array.isArray(manifest.urls)
) {
  throw new Error("Eduri offline manifest is unavailable");
}

const CACHE_VERSION = `${CACHE_PREFIX}${manifest.version}`;
const PRECACHE_URLS = [...new Set(manifest.urls.map((entry) => {
  if (typeof entry !== "string") {
    throw new TypeError("Eduri offline manifest contains a non-string URL");
  }
  const url = new URL(entry, self.location.origin);
  if (
    url.origin !== self.location.origin
    || url.pathname === "/api"
    || url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/board-sync")
  ) {
    throw new Error(`Eduri offline manifest contains a forbidden URL: ${entry}`);
  }
  return `${url.pathname}${url.search}`;
}))];

async function currentCache() {
  return caches.open(CACHE_VERSION);
}

function hasExpectedContentType(url, response) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const pathname = new URL(url, self.location.origin).pathname;
  if (pathname.endsWith(".html")) return contentType.includes("text/html");
  if (pathname.endsWith(".js")) {
    return contentType.includes("javascript") || contentType.includes("ecmascript");
  }
  if (pathname.endsWith(".css")) return contentType.includes("text/css");
  if (pathname.endsWith(".woff2")) {
    return contentType.includes("font/")
      || contentType.includes("application/font")
      || contentType.includes("application/octet-stream");
  }
  if (/\.(?:png|jpe?g|webp|gif|avif)$/u.test(pathname)) {
    return contentType.startsWith("image/");
  }
  return contentType.length > 0;
}

async function precacheBuild(cache) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(8, PRECACHE_URLS.length) },
    async () => {
      while (cursor < PRECACHE_URLS.length) {
        const url = PRECACHE_URLS[cursor];
        cursor += 1;
        const request = new Request(new URL(url, self.location.origin), {
          cache: "reload",
          credentials: "same-origin",
        });
        const response = await fetch(request);
        if (
          !response.ok
          || response.type !== "basic"
          || response.redirected
          || !hasExpectedContentType(url, response)
        ) {
          throw new Error(`Eduri offline resource is invalid: ${url}`);
        }
        await cache.put(request, response);
      }
    },
  );
  await Promise.all(workers);
}

async function assertPrecacheComplete(cache) {
  const missing = [];
  for (const url of PRECACHE_URLS) {
    if (!(await cache.match(url))) missing.push(url);
  }
  if (missing.length) {
    throw new Error(`Eduri offline cache is incomplete: ${missing.join(", ")}`);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await currentCache();
      await precacheBuild(cache);
      await assertPrecacheComplete(cache);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await currentCache();
      await assertPrecacheComplete(cache);
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
        .map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin
    || url.pathname === "/api"
    || url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/board-sync")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () =>
        (await (await currentCache()).match("/index.html")) || Response.error()),
    );
    return;
  }

  const cacheable = url.pathname.startsWith("/assets/")
    || url.pathname.endsWith(".worker.js")
    || ["script", "style", "font", "image"].includes(request.destination);
  if (!cacheable) return;
  event.respondWith(
    currentCache().then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (
          response.ok
          && response.type === "basic"
          && !response.redirected
          && hasExpectedContentType(request.url, response)
        ) {
          const copy = response.clone();
          void cache.put(request, copy);
        }
        return response;
      });
    }),
  );
});
