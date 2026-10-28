// netlify/functions/iniciar-compra.js
// Primeira ativação (sem teste grátis): { nome, email, plano } -> cria um pedido
// e abre o checkout do Mercado Pago. O código só nasce depois do pagamento aprovado.
const crypto = require("crypto");
const L = require("./lib/firestore");

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const b = L.parseBody(event);
        const nome = String(b.nome || "").trim().replace(/\s+/g, " ").slice(0, 80);
        const email = String(b.email || "").trim();
        const plano = L.PLANOS[b.plano];
        if (nome.length < 3) return L.resp(400, { erro: "Digite seu nome completo." });
        if (!L.emailValido(email) || !L.emailCanonico(email)) return L.resp(400, { erro: "E-mail inválido." });
        if (!plano) return L.resp(400, { erro: "Escolha um plano." });
        const site = (process.env.SITE_URL || process.env.URL || "").replace(/\/$/, "");
        if (!site) return L.resp(500, { erro: "SITE_URL não configurada no servidor." });

        const pedido = crypto.randomBytes(12).toString("hex");
        const g = await L.gravar([{ id: "o_" + pedido, criar: true, dados: {
            nome, email, whatsapp: L.zapNumero(b.whatsapp), emailCanon: L.emailCanonico(email), plano: b.plano, criadoEm: Date.now(), codigo: "",
            syncId: /^[A-Za-z0-9-]{4,40}$/.test(String(b.syncId || "")) ? String(b.syncId) : "" } }]);
        if (!g.ok) return L.resp(500, { erro: "Tente novamente." });

        const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
            method: "POST",
            headers: { Authorization: "Bearer " + process.env.MP_ACCESS_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({
                items: [{ id: b.plano, title: plano.titulo, quantity: 1, currency_id: "BRL", unit_price: plano.preco }],
                payer: { name: nome, email },
                external_reference: "P:" + pedido,
                notification_url: site + "/.netlify/functions/webhook-pagamento",
                back_urls: { success: site + "/?pago=1", pending: site + "/?pago=1", failure: site + "/?pago=0" },
                auto_return: "approved",
                payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }], installments: 1 },
                statement_descriptor: "NUTRICAFE",
            }),
        });
        const d = await r.json();
        if (!r.ok || !d.init_point) {
            console.error("MP preference:", r.status, JSON.stringify(d).slice(0, 300));
            return L.resp(502, { erro: "Não consegui abrir o pagamento agora. Tente novamente." });
        }
        return L.resp(200, { ok: true, url: d.init_point, pedido });
    } catch (e) {
        console.error("iniciar-compra:", e);
        return L.resp(500, { erro: "Erro no servidor. Tente novamente." });
    }
};
