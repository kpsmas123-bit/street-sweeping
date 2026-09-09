/* Cache the shell and both cities so the app answers with no signal.
   Bump CACHE when the ETL republishes data. */
var CACHE = 'sweeping-v8';   /* bump on every deploy that moves or renames a file */
var ASSETS = [
  './', './index.html', './app.js?v=8', './style.css?v=8', './manifest.json',
  'data/berkeley.json', 'data/oakland.json', 'data/holidays.json',
  'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.css'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    /* One bad URL must not fail the whole install. */
    return Promise.all(ASSETS.map(function (u) {
      return c.add(u).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                           .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* Network first so a fresh data build wins, cache as the fallback.

   Only http(s) requests are touched. MapLibre builds its geojson worker from a
   blob: URL, and intercepting that -- then failing in cache.put, which throws on
   any non-http scheme -- left the worker unable to start. The map then hung with
   its style permanently unloaded and no error raised anywhere. That only happens
   once a service worker is actually installed, so it reproduces on the deployed
   site and never locally. */
self.addEventListener('fetch', function (e) {
  var url;
  try {
    url = new URL(e.request.url);
  } catch (err) {
    return;
  }
  if (e.request.method !== 'GET') return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* GitHub Pages serves the app shell with Cache-Control: max-age=600, so after
     a deploy a returning visitor can run up to ten minutes of stale JavaScript
     against fresh data -- and a schema change between the two shows wrong
     answers rather than failing loudly. Revalidate the shell against the network
     every time; it is a few tens of kB. The city data keeps normal caching,
     since it is megabytes and only changes monthly. */
  var shell = url.origin === location.origin &&
              /\.(html|js|css|webmanifest)$|\/$|manifest\.json$/.test(url.pathname);
  var request = shell ? new Request(e.request, { cache: 'reload' }) : e.request;

  e.respondWith(
    fetch(request).then(function (res) {
      /* Never cache opaque or error responses -- they poison the offline copy. */
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) {
          c.put(e.request, copy).catch(function () {});
        });
      }
      return res;
    }).catch(function () { return caches.match(e.request); })
  );
});
