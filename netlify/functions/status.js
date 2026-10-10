// netlify/functions/status.js
// { codigo } -> validade do código. { pedido } -> depois do pagamento, devolve o código
// (só quem criou o pedido conhece esse identificador secreto).
const L = require("./lib/firestore");

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const b = L.parseBody(event);
        let codigo = L.normalizaCodigo(b.codigo);
        if (!codigo && b.pedido) {
            const id = String(b.pedido).replace(/[^a-f0-9]/g, "");
            const o = id ? await L.lerDoc("o_" + id) : null;
            if (!o) return L.resp(404, { erro: "Pedido não encontrado." });
            if (!o.dados.codigo) return L.resp(200, { ok: false, pendente: true, erro: "Aguardando a confirmação do pagamento." });
            codigo = o.dados.codigo;
        }
        if (!codigo) return L.resp(400, { erro: "Código inválido. Ele tem 8 letras/números (ex.: K7QM-4TXA)." });
        const c = await L.lerDoc("c_" + codigo);
        if (!c) return L.resp(404, { erro: "Código não encontrado. Confira o e-mail que você recebeu." });
        return L.resp(200, Object.assign({ ok: true }, L.statusDe(c.dados, Date.now())));
    } catch (e) {
        console.error("status:", e);
        return L.resp(500, { erro: "Erro no servidor. Tente novamente." });
    }
};
