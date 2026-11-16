// Staff app service worker. Only this site's own files are cached; orders, bills and guest data
// (Supabase) always go straight to the network and are never stored here.
// Pages, app.js and staff.css: network first (a new version shows on the next open), cache if offline.
// Hashed chunks, fonts, icons and images: cache first (their names change when they change).
const CACHE = "pd-staff-1";
const SHELL = ["./", "staff.css", "app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png", "../fonts/anek-latin.woff2", "../img/logo-emblem.webp"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pd-staff-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const longLived = (p) => /\/chunks\/|\/fonts\/|\/icons\/|\/img\//.test(p);

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (longLived(url.pathname)) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
            return res;
          })
      )
    );
    return;
  }
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === "navigate" ? "./" : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.mode === "navigate" ? "./" : req, { ignoreSearch: true }))
  );
});
