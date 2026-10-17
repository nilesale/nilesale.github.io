/* Nile Sale service worker: makes the site installable and keeps it opening offline. */
var VERSION = 'nilesale-v7';
var CORE = [
  './',
  'index.html',
  'js/config.js',
  'js/vendor/supabase-2.117.2.js',
  'js/backend.js',
  'data/seed.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(CORE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return; // fonts etc. go straight to the network

  var isStatic = /\/(logos|media|icons)\//.test(url.pathname);
  if (isStatic) {
    // images rarely change: cache first
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); return res;
      });
    }));
    return;
  }
  // pages, code and data: network first so updates show up, cache when offline
  e.respondWith(fetch(req).then(function (res) {
    var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); return res;
  }).catch(function () { return caches.match(req).then(function (hit) { return hit || caches.match('index.html'); }); }));
});
