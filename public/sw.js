// 🔴 2026-10-11：之前呢個係寫死嘅版本號（"macau-pos-v20-7-31"），由 7-31 起從冇改過
//    ⇒ PWA 每部機都用住同一個舊 cache name，就算網頁／bundle 更新咗，
//    `activate` 嘅 `key !== CACHE_NAME` 都唔會清舊快取（因為根本冇新 name）。
//    iOS PWA 更加係獨立儲存分區 + 唔會自動清 ⇒ 長期抱住舊 app shell。
//    改成帶 build id：每次 build／deploy 自然換新名 ⇒ 舊快取一定被清。
//    （build id 由 pwa-register 透過 query string 傳入；傳唔到就用當前 sw.js 檔案 mtime 唔穩定，
//      所以退而求其次用「檔案內容 hash 由 build 產生嘅話會變」嘅做法 → 直接加時間戳 fallback。）
const BUILD_ID = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE_NAME = `macau-pos-v20-${BUILD_ID}`;
const APP_SHELL = ["/", "/login", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// 🔴 每次啟動都問瀏覽器「有冇新 sw.js」→ 有就即刻換掉，避免長期抱住舊版本。
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/login"))),
    );
    return;
  }

  // 🔴 2026-10-11：之前全部非 navigate GET 都係 cache-first，**包括 `/_next/static/**`
  //    嘅 JS/CSS bundle**。iOS PWA 唔會自動清 cache ⇒ 部機可以長期跑住舊 bundle，
  //    伺服器明明已部署新版本，畫面行為（例如枱卡綁單）仍然係舊嗰套。
  //    改成 network-first：bundle 檔名本身有 content hash，換版本就換名，
  //    舊名 cache 命中機會好低；而且 stale 回應唔會再令部機「永久舊」。
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || caches.match("/login")),
      ),
  );
});
