// netlify/functions/criar-pagamento.js
// Recebe { codigo, plano } e cria um checkout do Mercado Pago (PIX ou cartão).
// O valor vem SEMPRE daqui — o app não consegue alterar preço.
const L = require("./lib/firestore");

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const b = L.parseBody(event);
        const codigo = L.normalizaCodigo(b.codigo);
        const plano = L.PLANOS[b.plano];
        if (!codigo || !plano) return L.resp(400, { erro: "Dados inválidos." });
        const c = await L.lerDoc("c_" + codigo);
        if (!c) return L.resp(404, { erro: "Código não encontrado." });

        const site = (process.env.SITE_URL || process.env.URL || "").replace(/\/$/, "");
        // para onde o cliente volta depois de pagar: a página de vendas (SITE_VENDAS_URL), ou o app
        const volta = (process.env.SITE_VENDAS_URL || site).replace(/\/$/, "");
        if (!site) return L.resp(500, { erro: "SITE_URL não configurada no servidor." });

        const pref = {
            items: [{ id: b.plano, title: plano.titulo, quantity: 1, currency_id: "BRL", unit_price: plano.preco }],
            payer: { name: c.dados.nome, email: c.dados.email },
            external_reference: codigo + "|" + b.plano,
            notification_url: site + "/.netlify/functions/webhook-pagamento",
            back_urls: { success: volta + "/?pago=1", pending: volta + "/?pago=1", failure: volta + "/?pago=0" },
            auto_return: "approved",
            payment_methods: {
                excluded_payment_types: [{ id: "ticket" }, { id: "atm" }],
                installments: 1,
            },
            statement_descriptor: "NUTRICAFE",
        };
        const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
            method: "POST",
            headers: { Authorization: "Bearer " + process.env.MP_ACCESS_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify(pref),
        });
        const d = await r.json();
        if (!r.ok || !d.init_point) {
            console.error("MP preference:", r.status, JSON.stringify(d).slice(0, 300));
            return L.resp(502, { erro: "Não consegui abrir o pagamento agora. Tente novamente." });
        }
        return L.resp(200, { ok: true, url: d.init_point });
    } catch (e) {
        console.error("criar-pagamento:", e);
        return L.resp(500, { erro: "Erro no servidor. Tente novamente." });
    }
};
