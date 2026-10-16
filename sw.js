// sw.js — service worker minimo do NutriCafe.
// Nao guarda nada em cache (o app sempre abre a versao mais nova);
// existe so para o Chrome oferecer a instalacao do app com 1 toque.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => new Response("Sem conexão. Abra o NutriCafé de novo quando tiver internet.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })));
  }
});
