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
        // Código de recuperação dos dados: o servidor é quem guarda e manda no e-mail.
        // App com dados próprios manda o dele (o servidor passa a seguir o app);
        // app vazio (celular novo) recebe o do servidor e puxa os dados da nuvem.
        let sync = c.dados.syncId || "";
        const doApp = L.syncIdValido(b.syncId) ? String(b.syncId) : "";
        let novo = "";
        if (doApp && (b.temDados || !sync) && doApp !== sync) novo = doApp;
        else if (!sync) novo = L.novoSyncId();
        if (novo) {
            const g = await L.gravar([{ id: "c_" + codigo, dados: { syncId: novo }, updateTime: c.updateTime }]).catch(() => ({ ok: false }));
            if (g && g.ok) sync = novo;
        }
        return L.resp(200, Object.assign({ ok: true }, L.statusDe(c.dados, Date.now()), { syncId: sync }));
    } catch (e) {
        console.error("status:", e);
        return L.resp(500, { erro: "Erro no servidor. Tente novamente." });
    }
};
