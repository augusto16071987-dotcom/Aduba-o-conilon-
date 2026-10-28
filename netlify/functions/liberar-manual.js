// netlify/functions/liberar-manual.js  (v3 - novo modelo por código)
// Uso interno (painel de suporte do app). { senha, busca, meses }
// acao:"listar" lista clientes; acao:"criar" cria acesso manual (nome+email+meses).
// "busca" pode ser código, e-mail ou parte do nome. Soma N meses.
const L = require("./lib/firestore");
const VERSAO = "v7-senha-env-2026-10-17";

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST.", versao: VERSAO });
    try {
        const b = L.parseBody(event);
        const senha = process.env.SUPORTE_SENHA;
        if (!senha) return L.resp(500, { erro: "SUPORTE_SENHA n\u00E3o configurada no servidor.", versao: VERSAO });
        const igual = typeof b.senha === "string" && b.senha.length === senha.length &&
            require("crypto").timingSafeEqual(Buffer.from(b.senha), Buffer.from(senha));
        if (!igual) { await new Promise(r => setTimeout(r, 1000)); return L.resp(401, { erro: "Senha incorreta.", versao: VERSAO }); }
        if (b.acao === "verificar") return L.resp(200, { ok: true, versao: VERSAO });
        if (b.acao === "listar") {
            const todos = await L.listarTodos("c_");
            const agora = Date.now();
            const lista = todos.map(x => ({ nome: x.dados.nome, email: x.dados.email, codigo: x.dados.codigo,
                whatsapp: x.dados.whatsapp || "", dias: L.diasPara(x.dados.validoAte, agora), validoAte: Number(x.dados.validoAte), vencimento: L.fmtData(Number(x.dados.validoAte)), ativo: Number(x.dados.validoAte) > agora }))
                .sort((a, b2) => b2.validoAte - a.validoAte);
            return L.resp(200, { ok: true, clientes: lista, versao: VERSAO });
        }
        const meses = Math.round(Number(b.meses));
        if (!(meses >= 1 && meses <= 36)) return L.resp(400, { erro: "Meses deve ser de 1 a 36." });
        if (b.acao === "criar") {
            const nome = String(b.nome || "").trim().replace(/\s+/g, " ").slice(0, 80);
            if (nome.length < 3 || !L.emailValido(String(b.email || "").trim())) return L.resp(400, { erro: "Informe nome completo e e-mail válido." });
            const r = await L.ativarOuRenovar({ nome, email: String(b.email).trim(), meses, marca: { liberadoManual: true } });
            await L.avisarPlanilha({ acao: r.novo ? "ativacao" : "renovacao", nome: r.dados.nome, email: r.dados.email, codigo: r.codigo,
                plano: (meses === 1 ? "1 mês" : meses + " meses"), valor: 0, manual: true, inicio: L.fmtData(Date.now()), vencimento: L.fmtData(r.validoAte) });
            return L.resp(200, { ok: true, nome: r.dados.nome, email: r.dados.email, codigo: r.codigo, validoAte: r.validoAte,
                vencimento: L.fmtData(r.validoAte), criado: r.novo, versao: VERSAO });
        }
        const busca = String(b.busca || b.nome || "").trim().toLowerCase();
        if (busca.length < 3) return L.resp(400, { erro: "Digite pelo menos 3 letras (nome, e-mail ou código)." });

        const todos = await L.listarTodos("c_");
        const cod = L.normalizaCodigo(busca);
        const canon = L.emailCanonico(busca);
        let achados = todos.filter(x => (cod && x.dados.codigo === cod) || (canon && x.dados.emailCanon === canon));
        if (!achados.length) achados = todos.filter(x =>
            String(x.dados.nome).toLowerCase().includes(busca) || String(x.dados.email).toLowerCase().includes(busca));
        if (!achados.length) return L.resp(404, { erro: "Ninguém encontrado com esse texto.", versao: VERSAO });
        if (achados.length > 1) return L.resp(409, { erro: "Mais de um cliente encontrado. Use o código ou o e-mail completo.",
            opcoes: achados.slice(0, 10).map(x => ({ nome: x.dados.nome, email: x.dados.email, codigo: x.dados.codigo })), versao: VERSAO });

        const alvo = achados[0];
        for (let t = 0; t < 3; t++) {
            const c = t === 0 ? alvo : await L.lerDoc(alvo.id);
            const agora = Date.now();
            const novo = L.somaMeses(Math.max(agora, Number(c.dados.validoAte) || 0), meses);
            const g = await L.gravar([{ id: alvo.id, updateTime: c.updateTime,
                dados: { validoAte: novo, trial: false, liberadoManual: true } }]);
            if (g.ok) {
                await L.avisarPlanilha({ acao: "renovacao", nome: c.dados.nome, email: c.dados.email, codigo: c.dados.codigo,
                    plano: (meses === 1 ? "1 mês" : meses + " meses"), valor: 0, manual: true, vencimento: L.fmtData(novo) });
                return L.resp(200, { ok: true, nome: c.dados.nome, email: c.dados.email, codigo: c.dados.codigo,
                    validoAte: novo, vencimento: L.fmtData(novo), versao: VERSAO });
            }
        }
        return L.resp(409, { erro: "Conflito ao gravar, tente de novo." });
    } catch (e) {
        console.error("liberar-manual:", e);
        return L.resp(500, { erro: "Erro no servidor.", versao: VERSAO });
    }
};
