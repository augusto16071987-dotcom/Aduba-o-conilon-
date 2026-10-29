// netlify/functions/webhook-pagamento.js
// O Mercado Pago avisa aqui quando um pagamento muda. NÃO confiamos no aviso:
// consultamos o pagamento na API do MP, conferimos valor/plano/status e só
// então somamos os meses. Cada pagamento só conta uma vez (documento p_<id>).
const L = require("./lib/firestore");

exports.handler = async (event) => {
    if (event.httpMethod === "GET") return L.resp(200, { ok: true, servico: "webhook-pagamento" });
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const q = event.queryStringParameters || {};
        const b = L.parseBody(event);
        const tipo = q.type || q.topic || b.type || b.topic || "";
        if (tipo && tipo !== "payment") return L.resp(200, { ignorado: tipo });
        const pid = String(q["data.id"] || q.id || (b.data && b.data.id) || b.id || "").replace(/[^0-9]/g, "");
        if (!pid) return L.resp(200, { ignorado: "sem id" });

        const r = await fetch("https://api.mercadopago.com/v1/payments/" + pid, {
            headers: { Authorization: "Bearer " + process.env.MP_ACCESS_TOKEN } });
        if (!r.ok) { console.error("MP GET payment", pid, r.status); return L.resp(r.status === 404 ? 200 : 500, { erro: "consulta" }); }
        const p = await r.json();
        if (p.status !== "approved") return L.resp(200, { ignorado: "status " + p.status });

        const ref = String(p.external_reference || "");
        const ehPedido = ref.indexOf("P:") === 0;
        const chave = ehPedido ? null : ref.split("|")[1];
        let plano = L.PLANOS[chave], codigoRenov = "", pedido = null, pedidoId = "";
        if (ehPedido) {
            pedidoId = ref.slice(2).replace(/[^a-f0-9]/g, "");
            pedido = pedidoId ? await L.lerDoc("o_" + pedidoId) : null;
            if (!pedido) { console.error("pedido sumiu", ref); return L.resp(200, { ignorado: "pedido" }); }
            plano = L.PLANOS[pedido.dados.plano];
        } else {
            codigoRenov = L.normalizaCodigo(ref.split("|")[0]);
        }
        if (!plano || (!ehPedido && !codigoRenov)) { console.error("ref inválida", ref); return L.resp(200, { ignorado: "ref" }); }
        if (p.currency_id !== "BRL" || Math.abs(Number(p.transaction_amount) - plano.preco) > 0.001) {
            console.error("valor divergente", pid, p.transaction_amount, plano.preco);
            return L.resp(200, { ignorado: "valor" });
        }
        if (await L.lerDoc("p_" + pid)) return L.resp(200, { ok: true, jaProcessado: true });
        const agora = Date.now();
        const pgto = { id: "p_" + pid, criar: true, dados: { plano: ehPedido ? pedido.dados.plano : chave, valor: Math.round(plano.preco * 100), em: agora } };

        if (ehPedido) {
            const r2 = await L.ativarOuRenovar({ nome: pedido.dados.nome, email: pedido.dados.email, meses: plano.meses, extras: [pgto], whatsapp: pedido.dados.whatsapp });
            // liga o pedido ao código (o app descobre o código por aqui)
            await L.gravar([{ id: "o_" + pedidoId, dados: { codigo: r2.codigo }, updateTime: (await L.lerDoc("o_" + pedidoId)).updateTime }]).catch(() => {});
            const acao = r2.novo ? "ativacao" : "renovacao";
            const syncId = r2.dados.syncId || "";
            await L.avisarPlanilha({ acao, syncId, nome: r2.dados.nome, email: r2.dados.email, codigo: r2.codigo,
                plano: plano.titulo, valor: plano.preco, inicio: L.fmtData(agora), vencimento: L.fmtData(r2.validoAte) });
            return L.resp(200, { ok: true });
        }
        for (let t = 0; t < 4; t++) {
            const c = await L.lerDoc("c_" + codigoRenov);
            if (!c) { console.error("cliente sumiu", codigoRenov); return L.resp(200, { ignorado: "cliente" }); }
            const novo = L.somaMeses(Math.max(agora, Number(c.dados.validoAte) || 0), plano.meses);
            const g = await L.gravar([pgto, { id: "c_" + codigoRenov, updateTime: c.updateTime, dados: { validoAte: novo, ultimoPagamento: agora } }]);
            if (g.ok) {
                await L.avisarPlanilha({ acao: "renovacao", syncId: c.dados.syncId || "", nome: c.dados.nome, email: c.dados.email, codigo: codigoRenov,
                    plano: plano.titulo, valor: plano.preco, vencimento: L.fmtData(novo) });
                return L.resp(200, { ok: true });
            }
            if ((await L.lerDoc("p_" + pid))) return L.resp(200, { ok: true, jaProcessado: true });
        }
        return L.resp(500, { erro: "conflito, tentar de novo" }); // MP reenvia
    } catch (e) {
        console.error("webhook:", e);
        return L.resp(500, { erro: "erro" });
    }
};
