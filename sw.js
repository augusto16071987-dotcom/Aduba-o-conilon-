// sw.js — service worker do NutriCafe (v2: funciona sem internet).
//
// O que faz:
//  1) Guarda no aparelho a "casca" do app (index.html) e as bibliotecas
//     (React, Tailwind, jsPDF, Chart.js, pdf.js). Depois da 1a vez com
//     internet, o app abre mesmo sem sinal.
//  2) Com internet, sempre busca a versao mais nova do index.html primeiro
//     (se a rede demorar mais de 5s e ja houver copia guardada, abre a copia).
//  3) NUNCA guarda chamadas de servidor (Netlify functions, Firebase,
//     tempo, preco do cafe...). Essas so funcionam com internet.
//
// Se mudar este arquivo, o navegador atualiza o service worker sozinho.
const VERSAO = "nc-sw-v2";
const CACHE = "nutricafe-" + VERSAO;
const CDN = [
  "https://cdn.tailwindcss.com",
  "https://unpkg.com/react@18/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18/umd/react-dom.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
];
const HOSTS_CACHE = ["cdn.tailwindcss.com", "unpkg.com", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];
const CASCA = new URL("index.html", self.registration.scope).toString();

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled([
      fetch(CASCA, { cache: "reload" }).then((r) => { if (r.ok) return c.put(CASCA, r); }),
      fetch("manifest.json", { cache: "reload" }).then((r) => { if (r.ok) return c.put("manifest.json", r); }),
      ...CDN.map((u) => fetch(new Request(u, { mode: "no-cors" })).then((r) => c.put(u, r))),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter((n) => n.startsWith("nutricafe-") && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

const SEM_CONEXAO = () => new Response("Sem conexão e o app ainda não foi guardado neste aparelho. Abra o NutriCafé uma vez com internet.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });

async function paginaPrincipal(req) {
  const c = await caches.open(CACHE);
  const guardada = await c.match(CASCA);
  const rede = fetch(req).then((r) => { if (r && r.ok) c.put(CASCA, r.clone()); return r; });
  if (!guardada) return rede.catch(SEM_CONEXAO);
  // tem copia guardada: espera a rede ate 5s; se falhar/demorar, abre a copia
  rede.catch(() => { });
  const limite = new Promise((res) => setTimeout(() => res(null), 5000));
  try {
    const r = await Promise.race([rede, limite]);
    return r || guardada;
  } catch (err) {
    return guardada;
  }
}

async function guardarPrimeiro(req) {
  const c = await caches.open(CACHE);
  const achou = await c.match(req);
  if (achou) return achou;
  const r = await fetch(req);
  if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone());
  return r;
}

async function guardadoEAtualiza(req) {
  const c = await caches.open(CACHE);
  const achou = await c.match(req);
  const rede = fetch(req).then((r) => { if (r && r.ok) c.put(req, r.clone()); return r; });
  if (achou) { rede.catch(() => { }); return achou; }
  return rede;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // verificacao de versao do app (aviso "Nova versao"): sempre direto da rede
  if (url.searchParams.has("_v") || req.headers.has("range")) return;
  if (req.mode === "navigate" && url.origin === self.location.origin) {
    e.respondWith(paginaPrincipal(req));
    return;
  }
  if (HOSTS_CACHE.includes(url.hostname)) {
    e.respondWith(guardarPrimeiro(req).catch(() => new Response("", { status: 504 })));
    return;
  }
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/.netlify/")) return;
    if (url.pathname === "/" || url.pathname.endsWith("/index.html") || url.pathname.endsWith("/sw.js")) return;
    e.respondWith(guardadoEAtualiza(req).catch(() => new Response("", { status: 504 })));
  }
});
