// netlify/functions/pedido-teste.js
// Chamado pela página de divulgação quando a pessoa pede o teste grátis.
// Só guarda o pedido (nome, e-mail, WhatsApp) para você liberar no painel de suporte.
// Não cria acesso nenhum e não manda e-mail.
const crypto = require("crypto");
const L = require("./lib/firestore");

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const b = L.parseBody(event);
        const nome = String(b.nome || "").trim().replace(/\s+/g, " ").slice(0, 80);
        const email = String(b.email || "").trim().slice(0, 120);
        const zap = L.zapNumero(b.whatsapp);
        if (nome.length < 3) return L.resp(400, { erro: "Digite seu nome completo." });
        if (!L.emailValido(email) || !L.emailCanonico(email)) return L.resp(400, { erro: "E-mail inválido." });
        if (!zap) return L.resp(400, { erro: "Informe o WhatsApp com DDD." });
        const canon = L.emailCanonico(email);
        // um pedido por e-mail: pedir de novo só atualiza os dados
        const id = "t_" + crypto.createHash("sha1").update(canon).digest("hex").slice(0, 20);
        const g = await L.gravar([{ id, dados: { nome, email, emailCanon: canon, whatsapp: zap, criadoEm: Date.now() } }]);
        if (!g.ok) return L.resp(500, { erro: "Não consegui registrar agora." });
        return L.resp(200, { ok: true });
    } catch (e) {
        console.error("pedido-teste:", e);
        return L.resp(500, { erro: "Erro no servidor." });
    }
};
