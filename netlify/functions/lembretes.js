// netlify/functions/lembretes.js
// Chamado todo dia (pelo gatilho do Apps Script). Manda e-mail de lembrete:
//  - 7 dias antes de vencer, 1 dia antes, e depois que venceu (até 3 dias).
// Cada lembrete é enviado uma vez por vencimento (some sozinho quando o cliente renova).
const L = require("./lib/firestore");
const MAX_POR_EXECUCAO = 15;

exports.handler = async (event) => {
    if (event.httpMethod === "GET") return L.resp(200, { ok: true, servico: "lembretes" });
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const b = L.parseBody(event);
        if (!process.env.APPS_SCRIPT_SEGREDO || b.segredo !== process.env.APPS_SCRIPT_SEGREDO) return L.resp(401, { erro: "Não autorizado." });
        const site = (process.env.SITE_URL || process.env.URL || "").replace(/\/$/, "");
        const agora = Date.now();
        const todos = await L.listarTodos("c_");
        const fila = [];
        for (const x of todos) {
            const d = x.dados, v = Number(d.validoAte), dias = L.diasPara(v, agora);
            let tipo = "";
            if (dias <= 0 && dias >= -3 && Number(d.l0) !== v) tipo = "l0";
            else if (dias >= 1 && dias <= 1 && Number(d.l1) !== v) tipo = "l1";
            else if (dias >= 2 && dias <= 7 && Number(d.l7) !== v) tipo = "l7";
            if (tipo) fila.push({ x, tipo, dias });
        }
        if (b.simular) return L.resp(200, { ok: true, simulacao: true, total: fila.length,
            fila: fila.map(f => ({ nome: f.x.dados.nome, email: f.x.dados.email, tipo: f.tipo, dias: f.dias })) });
        let enviados = 0, falhas = 0;
        for (const f of fila.slice(0, MAX_POR_EXECUCAO)) {
            const d = f.x.dados, v = Number(d.validoAte);
            const r = await L.avisarPlanilha({ acao: "lembrete", tipo: f.tipo, dias: f.dias, nome: d.nome, email: d.email,
                codigo: d.codigo, vencimento: L.fmtData(v), link: site });
            if (!r.ok) { falhas++; continue; }
            // marca como enviado (e o de 7 dias também, se for o de 1 dia / vencido)
            const marca = {}; marca[f.tipo] = v;
            if (f.tipo !== "l7") marca.l7 = v;
            if (f.tipo === "l0") marca.l1 = v;
            await L.gravar([{ id: f.x.id, dados: marca, updateTime: f.x.updateTime }]).catch(() => {});
            enviados++;
        }
        return L.resp(200, { ok: true, enviados, falhas, pendentes: Math.max(0, fila.length - MAX_POR_EXECUCAO) });
    } catch (e) {
        console.error("lembretes:", e);
        return L.resp(500, { erro: "Erro no servidor." });
    }
};
