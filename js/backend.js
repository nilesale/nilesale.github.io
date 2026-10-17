/*
 * Nile Sale — local backend
 * -------------------------------------------------------------
 * The original app was built inside Claude and used Claude's built-in
 * storage (window.claude.use('db' | 'user' | 'assets')). This file
 * provides the same interface on a normal website, so the app code
 * stays almost untouched.
 *
 * Where data lives in this version:
 *   - listings, accounts, favourites → this browser's localStorage
 *   - uploaded photos                → this browser's IndexedDB
 * So every visitor sees the demo listings plus what THEY add on THEIR
 * device. Nothing is shared between visitors yet. The next step is to
 * replace this file with a Supabase-backed version that has the same
 * interface (doc / collection / onSnapshot / add / set / update / delete).
 */
(function () {
  'use strict';

  var DB_KEY = 'nilesale.db.v1';
  var UID_KEY = 'nilesale.uid';
  var IDB_NAME = 'nilesale-media';
  var MAX_UPLOAD = 10 * 1024 * 1024;

  /* ---------- helpers ---------- */
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function rid(n, abc) {
    abc = abc || 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '', a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < n; i++) out += abc[a[i] % abc.length];
    return out;
  }
  function parentOf(path) { var i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
  function idOf(path) { return path.slice(path.lastIndexOf('/') + 1); }
  function later(fn) { setTimeout(fn, 0); }
  function err(code, msg) { var e = new Error(msg || code); e.code = code; return e; }

  /* ---------- document store (localStorage) ---------- */
  var store = { docs: {}, meta: {} };
  function loadStore() {
    try {
      var raw = localStorage.getItem(DB_KEY);
      var v = raw ? JSON.parse(raw) : null;
      if (v && v.docs) store = v;
    } catch (e) { /* private mode or blocked storage: keep in memory */ }
  }
  function saveStore() {
    try { localStorage.setItem(DB_KEY, JSON.stringify(store)); return true; }
    catch (e) { console.warn('[Nile Sale] could not save to localStorage', e); return false; }
  }

  /* ---------- live listeners ---------- */
  var listeners = [];
  function docSnap(path) {
    var d = store.docs[path];
    return { id: idOf(path), exists: d !== undefined, data: function () { return clone(d); } };
  }
  function runQuery(q) {
    var rows = [];
    Object.keys(store.docs).forEach(function (p) {
      if (parentOf(p) === q.coll) rows.push(p);
    });
    if (q.order) {
      var f = q.order.field, desc = q.order.dir === 'desc';
      rows.sort(function (a, b) {
        var x = store.docs[a][f], y = store.docs[b][f];
        x = x == null ? -Infinity : x; y = y == null ? -Infinity : y;
        return x < y ? (desc ? 1 : -1) : x > y ? (desc ? -1 : 1) : 0;
      });
    }
    if (q.limit) rows = rows.slice(0, q.limit);
    var docs = rows.map(docSnap);
    return { docs: docs, size: docs.length, empty: docs.length === 0 };
  }
  function fire(l) {
    try { l.cb(l.kind === 'doc' ? docSnap(l.path) : runQuery(l.q)); }
    catch (e) { console.error('[Nile Sale] listener error', e); }
  }
  function notify(path) {
    var coll = parentOf(path);
    listeners.slice().forEach(function (l) {
      if (l.kind === 'doc' ? l.path === path : l.q.coll === coll) later(function () { if (l.live) fire(l); });
    });
  }
  function notifyAll() { listeners.slice().forEach(function (l) { later(function () { if (l.live) fire(l); }); }); }
  window.addEventListener('storage', function (e) { if (e.key === DB_KEY) { loadStore(); notifyAll(); } });

  function listen(l) {
    l.live = true; listeners.push(l); later(function () { if (l.live) fire(l); });
    return function () { l.live = false; listeners = listeners.filter(function (x) { return x !== l; }); };
  }

  function write(path, data) {
    store.docs[path] = clone(data);
    if (!saveStore()) return Promise.reject(err('quota_exceeded', 'Storage is full on this device'));
    notify(path); return Promise.resolve();
  }

  function docRef(path) {
    return {
      id: idOf(path), path: path,
      get: function () { return Promise.resolve(docSnap(path)); },
      set: function (data) { return write(path, data); },
      update: function (part) {
        var cur = store.docs[path];
        if (cur === undefined) return Promise.reject(err('not_found', 'Document does not exist'));
        return write(path, Object.assign({}, cur, clone(part)));
      },
      delete: function () {
        var prefix = path + '/';
        Object.keys(store.docs).forEach(function (p) { if (p === path || p.indexOf(prefix) === 0) delete store.docs[p]; });
        saveStore(); notify(path); return Promise.resolve();
      },
      onSnapshot: function (cb, onErr) { return listen({ kind: 'doc', path: path, cb: cb, onErr: onErr }); }
    };
  }
  function query(coll, order, limit) {
    return {
      orderBy: function (field, dir) { return query(coll, { field: field, dir: dir || 'asc' }, limit); },
      limit: function (n) { return query(coll, order, n); },
      get: function () { return Promise.resolve(runQuery({ coll: coll, order: order, limit: limit })); },
      onSnapshot: function (cb, onErr) { return listen({ kind: 'query', q: { coll: coll, order: order, limit: limit }, cb: cb, onErr: onErr }); },
      add: function (data) { var id = rid(20); var p = coll + '/' + id; return write(p, data).then(function () { return { id: id, path: p }; }); },
      doc: function (id) { return docRef(coll + '/' + (id || rid(20))); }
    };
  }
  var db = { doc: docRef, collection: function (c) { return query(c, null, 0); } };

  /* ---------- photos (IndexedDB) ---------- */
  var blobUrls = {};
  var idbP = null;
  function idb() {
    if (idbP) return idbP;
    idbP = new Promise(function (res) {
      try {
        var r = indexedDB.open(IDB_NAME, 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('blobs'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
    return idbP;
  }
  function idbAll() {
    return idb().then(function (d) {
      if (!d) return;
      return new Promise(function (res) {
        var tx = d.transaction('blobs', 'readonly'), os = tx.objectStore('blobs');
        var req = os.openCursor();
        req.onsuccess = function () {
          var c = req.result;
          if (c) { try { blobUrls[c.key] = URL.createObjectURL(c.value); } catch (e) {} c.continue(); } else res();
        };
        req.onerror = function () { res(); };
      });
    });
  }
  var assets = {
    upload: function (blob) {
      if (!blob || !blob.size) return Promise.reject(err('unsupported_type'));
      if (blob.size > MAX_UPLOAD) return Promise.reject(err('too_large'));
      var id = rid(32, '0123456789abcdef');
      return idb().then(function (d) {
        if (!d) throw err('quota_or_state');
        return new Promise(function (res, rej) {
          var tx = d.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').put(blob, id);
          tx.oncomplete = function () { blobUrls[id] = URL.createObjectURL(blob); res({ id: id, url: blobUrls[id] }); };
          tx.onerror = function () { rej(err('quota_or_state')); };
        });
      });
    },
    delete: function (id) {
      if (blobUrls[id]) { try { URL.revokeObjectURL(blobUrls[id]); } catch (e) {} delete blobUrls[id]; }
      return idb().then(function (d) {
        if (!d) return;
        return new Promise(function (res) { var tx = d.transaction('blobs', 'readwrite'); tx.objectStore('blobs').delete(id); tx.oncomplete = res; tx.onerror = res; });
      });
    }
  };

  /* ---------- image addresses used by the app ---------- */
  var media = {};
  window.__nsBlob = function (id) {
    id = String(id || '');
    if (blobUrls[id]) return blobUrls[id];
    if (id.indexOf('logo_c_') === 0) return 'logos/cars/' + id.slice(7) + '.png';
    if (id.indexOf('logo_m_') === 0) return 'logos/moto/' + id.slice(7) + '.png';
    if (media[id]) return 'media/' + media[id];
    return 'media/missing.svg';
  };

  /* ---------- visitor identity ---------- */
  // A device id is used until the visitor signs in with Google or Apple;
  // after that the Supabase account id is used (and kept after sign-out).
  var AUTH_UID_KEY = 'nilesale.authUid';
  var deviceUid = null, authUid = null;
  try { deviceUid = localStorage.getItem(UID_KEY); authUid = localStorage.getItem(AUTH_UID_KEY); } catch (e) {}
  if (!deviceUid) { deviceUid = 'u_' + rid(22, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'); try { localStorage.setItem(UID_KEY, deviceUid); } catch (e) {} }
  var uid = authUid || deviceUid;

  /* ---------- real sign-in: Google / Apple through Supabase Auth ---------- */
  var PENDING_KEY = 'nilesale.pending';
  var cfg = window.NILESALE_CONFIG || {};
  var sb = null;
  if (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && typeof window.supabase.createClient === 'function') {
    try {
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', experimental: { passkey: true } }
      });
    } catch (e) { console.warn('[Nile Sale] Supabase did not start', e); }
  }
  var auth = {
    enabled: !!sb,
    error: '',
    justSignedIn: null,
    has: function (p) { return !!sb && !!(cfg.providers && cfg.providers[p]); },
    signIn: function (p, pending) {
      if (!auth.has(p)) return Promise.reject(err('provider_off'));
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending || {})); } catch (e) {}
      // Google: Google's own button hands us an ID token, so no client secret is needed
      if (p === 'google' && cfg.googleClientId) return googleSignIn();
      var back = location.origin + location.pathname;
      return sb.auth.signInWithOAuth({ provider: p, options: { redirectTo: back } })
        .then(function (r) { if (r && r.error) throw r.error; });
    },
    signOut: function () { return sb ? sb.auth.signOut().catch(function () {}) : Promise.resolve(); },
    // fingerprint / Face ID sign-in (passkeys)
    passkeyOk: function () { return !!sb && cfg.passkeys !== false && !!window.PublicKeyCredential && !!(sb.auth.signInWithPasskey); },
    signInPasskey: function (pending) {
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending || {})); } catch (e) {}
      return sb.auth.signInWithPasskey().then(function (r) {
        if (r && r.error) throw r.error;
        try { localStorage.setItem('nilesale.lastAuth', 'passkey'); } catch (e) {}
        location.reload();
      }).catch(function (e) { throw pkErr(e); });
    },
    registerPasskey: function () {
      return sb.auth.registerPasskey().then(function (r) { if (r && r.error) throw r.error; return r.data; })
        .catch(function (e) { throw pkErr(e); });
    },
    // keep name + phone on the Supabase account too, so they come back on any device
    saveProfile: function (o) {
      if (!sb) return Promise.resolve();
      return sb.auth.updateUser({ data: { full_name: o.name, phone: o.phone, phone_local: o.phoneLocal } })
        .catch(function (e) { console.warn('[Nile Sale] profile not saved online', e); });
    },
    takePending: function () {
      var v = null;
      try { v = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); sessionStorage.removeItem(PENDING_KEY); } catch (e) {}
      return v;
    }
  };
  window.__nsAuth = auth;
  function pkErr(e) {
    var s = String((e && (e.code || e.error_code || e.name)) || '') + ' ' + String((e && e.message) || '');
    console.warn('[Nile Sale] passkey', e);
    if (/NotAllowed|ABORT|cancel/i.test(s)) return err('cancel');
    if (/credential_not_found/i.test(s)) return err('no_passkey');
    if (/credential_exists|InvalidState|already/i.test(s)) return err('exists');
    return err('passkey_failed', s);
  }

  /* ---------- Google sign-in with Google Identity Services ---------- */
  var gisLoading = null;
  (function () { var st = document.createElement('style'); st.textContent = 'dialog.ns-gis::backdrop{background:rgba(0,0,0,.6)}'; document.head.appendChild(st); })();
  function loadGis() {
    if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
    if (gisLoading) return gisLoading;
    gisLoading = new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = function () { ok(); };
      s.onerror = function () { gisLoading = null; bad(err('gis_load')); };
      document.head.appendChild(s);
    });
    return gisLoading;
  }
  function sha256Hex(str) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  function googleSignIn() {
    var ar = (document.documentElement.lang || 'ar').indexOf('ar') === 0;
    var raw = rid(32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
    return Promise.all([loadGis(), sha256Hex(raw)]).then(function (r) {
      var hashed = r[1];
      return new Promise(function (ok, bad) {
        var done = false;
        // a real <dialog> so it shows above the site's own sign-in sheet
        var box = document.createElement('dialog');
        box.className = 'ns-gis';
        box.style.cssText = 'border:0;padding:16px;background:transparent;max-width:none;max-height:none;width:100%;height:100%;margin:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box';
        var card = document.createElement('div');
        card.style.cssText = 'background:#fff;color:#111;border-radius:16px;padding:22px 18px;max-width:340px;width:100%;text-align:center;font-family:inherit;box-shadow:0 10px 40px rgba(0,0,0,.3)';
        card.dir = ar ? 'rtl' : 'ltr';
        var title = document.createElement('div');
        title.textContent = ar ? 'تسجيل الدخول بحساب جوجل' : 'Sign in with Google';
        title.style.cssText = 'font-weight:700;font-size:17px;margin-bottom:14px';
        var slot = document.createElement('div');
        slot.style.cssText = 'display:flex;justify-content:center;min-height:44px';
        var msg = document.createElement('div');
        msg.style.cssText = 'font-size:13px;color:#666;margin-top:12px;min-height:18px';
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = ar ? 'إلغاء' : 'Cancel';
        cancel.style.cssText = 'margin-top:12px;background:none;border:0;color:#555;font:inherit;font-size:14px;cursor:pointer;padding:8px 16px';
        card.appendChild(title); card.appendChild(slot); card.appendChild(msg); card.appendChild(cancel);
        box.appendChild(card); document.body.appendChild(box);
        try { box.showModal(); } catch (e) { box.setAttribute('open', ''); }
        box.addEventListener('cancel', function (e) { e.preventDefault(); stop(); });
        function close() { try { box.close(); } catch (e) {} if (box.parentNode) box.parentNode.removeChild(box); }
        function stop() { if (done) return; done = true; close(); bad(err('cancel')); }
        cancel.onclick = stop;
        box.addEventListener('click', function (e) { if (e.target === box) stop(); });
        google.accounts.id.initialize({
          client_id: cfg.googleClientId,
          nonce: hashed,
          ux_mode: 'popup',
          use_fedcm_for_prompt: true,
          callback: function (resp) {
            if (done) return;
            msg.textContent = ar ? 'جاري تسجيل الدخول…' : 'Signing in…';
            sb.auth.signInWithIdToken({ provider: 'google', token: resp.credential, nonce: raw }).then(function (res) {
              if (res.error) throw res.error;
              done = true;
              try { localStorage.setItem('nilesale.lastAuth', 'google'); } catch (e) {}
              // reload so the whole app picks up the account (the unsent ad is kept)
              location.reload();
              ok();
            }).catch(function (e) {
              done = true; close();
              console.warn('[Nile Sale] Google sign-in failed', e);
              bad(e);
            });
          }
        });
        google.accounts.id.renderButton(slot, {
          type: 'standard', theme: 'outline', size: 'large', shape: 'pill',
          text: 'continue_with', locale: ar ? 'ar' : 'en', width: 280
        });
      });
    });
  }

  // move what this device posted before signing in over to the real account
  function moveOwner(a, b) {
    var pre = 'data/users/' + a + '/';
    Object.keys(store.docs).forEach(function (p) {
      var d = store.docs[p];
      if (p.indexOf(pre) === 0) {
        var np = 'data/users/' + b + '/' + p.slice(pre.length);
        if (store.docs[np] === undefined) store.docs[np] = d;
        delete store.docs[p]; return;
      }
      if (/^listings\/[^/]+\/entries\/[^/]+$/.test(p) && idOf(p) === a) {
        store.docs[parentOf(p) + '/' + b] = d; delete store.docs[p]; return;
      }
      if (d && typeof d === 'object') {
        if (d.sellerId === a) d.sellerId = b;
        if (d.bidderId === a) d.bidderId = b;
        if (d.lastBidderId === a) d.lastBidderId = b;
      }
    });
    if (store.docs['profiles/' + a]) {
      if (!store.docs['profiles/' + b]) store.docs['profiles/' + b] = store.docs['profiles/' + a];
      delete store.docs['profiles/' + a];
    }
  }

  function adoptUser(u) {
    var id = u.id;
    if (uid === deviceUid && deviceUid !== id) moveOwner(deviceUid, id);
    uid = id;
    try { localStorage.setItem(AUTH_UID_KEY, id); } catch (e) {}
    var md = u.user_metadata || {};
    var provs = (u.app_metadata && u.app_metadata.providers) || [];
    var provider = (u.app_metadata && u.app_metadata.provider) === 'apple' || provs.indexOf('apple') >= 0 && provs.indexOf('google') < 0 ? 'apple' : 'google';
    var name = String(md.full_name || md.name || (u.email || '').split('@')[0] || '').slice(0, 60);
    var accPath = 'data/users/' + id + '/account';
    var prev = store.docs[accPath] || {};
    var now = Date.now();
    var acc = Object.assign({}, prev, {
      method: provider, name: prev.name || name, email: u.email || prev.email || '',
      phone: prev.phone || String(md.phone || ''), phoneLocal: prev.phoneLocal || String(md.phone_local || ''),
      signedIn: true, createdAt: prev.createdAt || now
    });
    if (!prev.signedIn) auth.justSignedIn = { name: acc.name };
    store.docs[accPath] = acc;
    var pp = 'profiles/' + id;
    store.docs[pp] = Object.assign({ joinedAt: now }, store.docs[pp] || {}, { name: acc.name, method: provider });
    saveStore();
  }

  function startAuth() {
    if (!sb) return Promise.resolve();
    var q = new URLSearchParams(location.search.slice(1) + '&' + location.hash.slice(1));
    var urlErr = q.get('error_description') || q.get('error') || '';
    return sb.auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session;
      if (s && s.user) adoptUser(s.user);
      else if (urlErr) auth.error = urlErr;
    }).catch(function (e) {
      auth.error = String((e && e.message) || e);
    }).then(function () {
      // tidy the address bar after coming back from Google / Apple
      if (/[?&#](code|error|error_description|access_token)=/.test(location.href)) {
        try { history.replaceState(null, '', location.pathname); } catch (e) {}
      }
    });
  }

  var user = {
    id: function () { return Promise.resolve(uid); },
    me: function () { return Promise.resolve({ id: uid, name: '' }); },
    canEdit: function () { return Promise.resolve(false); },
    profiles: function () { return Promise.resolve({}); }
  };

  /* ---------- first-run demo data ---------- */
  function loadSeed() {
    return fetch('data/seed.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (seed) {
      if (!seed) return;
      (seed.mediaFiles || []).forEach(function (f) { media[f.split('.')[0]] = f; });
      var have = Number(store.meta.seedVersion) || 0;
      if (have >= seed.version) return;
      Object.keys(seed.docs || {}).forEach(function (p) {
        // add new demo documents; never overwrite what the visitor changed
        if (store.docs[p] === undefined || p.indexOf('brandLogos/') === 0) store.docs[p] = seed.docs[p];
      });
      store.meta.seedVersion = seed.version;
      saveStore();
    }).catch(function (e) { console.warn('[Nile Sale] demo data not loaded', e); });
  }

  loadStore();
  var ready = Promise.all([loadSeed(), idbAll()]).then(startAuth);

  var services = { db: db, user: user, assets: assets, sample: null, permissions: null };
  window.claude = {
    use: function (name) { return ready.then(function () { return services[name] === undefined ? null : services[name]; }); }
  };

  /* ---------- installable app ---------- */
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
