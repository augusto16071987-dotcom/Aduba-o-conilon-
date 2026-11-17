// netlify/functions/liberar-manual.js  (v3 - novo modelo por código)
// Uso interno (painel de suporte do app). { senha, busca, meses }
// acao:"listar" lista clientes; acao:"criar" cria acesso manual (nome+email+meses).
// "busca" pode ser código, e-mail ou parte do nome. Soma N meses.
const L = require("./lib/firestore");
const VERSAO = "v8-pedidos-teste-2026-11-17";

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
        if (b.acao === "excluir") {
            const cod = L.normalizaCodigo(b.codigo);
            if (!cod) return L.resp(400, { erro: "C\u00F3digo inv\u00E1lido." });
            const c = await L.lerDoc("c_" + cod);
            if (!c) return L.resp(404, { erro: "Cliente n\u00E3o encontrado.", versao: VERSAO });
            const ids = ["c_" + cod];
            const canon = L.emailCanonico(c.dados.email);
            if (canon) { const ex = await L.lerDoc(L.idEmail(canon)); if (ex && ex.dados.codigo === cod) ids.push(L.idEmail(canon)); }
            let nuvemApagados = 0;
            if (b.nuvem) {
                // apaga também a cópia da lavoura na nuvem (tudo que começa com <código de recuperação>--)
                const sid = String(c.dados.syncId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
                if (sid.length >= 6) {
                    const docs = await L.listarTodos(sid + "--", L.COLECAO_DADOS_APP);
                    const nomes = docs.map((d) => d.id);
                    for (let i = 0; i < nomes.length; i += 100) await L.excluirDocs(nomes.slice(i, i + 100), L.COLECAO_DADOS_APP);
                    nuvemApagados = nomes.length;
                }
            }
            await L.excluirDocs(ids);
            await L.avisarPlanilha({ acao: "exclusao", codigo: cod, nome: c.dados.nome, email: c.dados.email });
            return L.resp(200, { ok: true, excluido: cod, nuvemApagados, versao: VERSAO });
        }
        // ---- pedidos de teste vindos da página de divulgação ----
        const ID_PEDIDO = /^t_[a-f0-9]{20}$/;
        if (b.acao === "pedidos") {
            const todos = await L.listarTodos("t_");
            const agora = Date.now();
            const lista = [];
            for (const x of todos) {
                const ex = x.dados.emailCanon ? await L.lerDoc(L.idEmail(x.dados.emailCanon)) : null;
                let ja = null;
                if (ex) { const c = await L.lerDoc("c_" + ex.dados.codigo); if (c) ja = { codigo: c.dados.codigo, vencimento: L.fmtData(Number(c.dados.validoAte)), ativo: Number(c.dados.validoAte) > agora }; }
                lista.push({ id: x.id, nome: x.dados.nome, email: x.dados.email, whatsapp: x.dados.whatsapp || "", criadoEm: Number(x.dados.criadoEm) || 0, quando: L.fmtData(Number(x.dados.criadoEm) || agora), jaCliente: ja });
            }
            lista.sort((p, q) => q.criadoEm - p.criadoEm);
            return L.resp(200, { ok: true, pedidos: lista, versao: VERSAO });
        }
        if (b.acao === "descartar-pedido") {
            if (!ID_PEDIDO.test(String(b.id || ""))) return L.resp(400, { erro: "Pedido inválido." });
            await L.excluirDocs([b.id]);
            return L.resp(200, { ok: true });
        }
        if (b.acao === "liberar-pedido") {
            if (!ID_PEDIDO.test(String(b.id || ""))) return L.resp(400, { erro: "Pedido inválido." });
            const m = Math.round(Number(b.meses) || 1);
            if (!(m >= 1 && m <= 36)) return L.resp(400, { erro: "Meses deve ser de 1 a 36." });
            const ped = await L.lerDoc(b.id);
            if (!ped) return L.resp(404, { erro: "Pedido não encontrado (talvez já liberado)." });
            const r = await L.ativarOuRenovar({ nome: ped.dados.nome, email: ped.dados.email, meses: m, whatsapp: ped.dados.whatsapp, marca: { liberadoManual: true } });
            await L.avisarPlanilha({ acao: r.novo ? "ativacao" : "renovacao", syncId: r.dados.syncId || "", nome: r.dados.nome, email: r.dados.email, codigo: r.codigo,
                plano: (m === 1 ? "1 mês (teste)" : m + " meses"), valor: 0, manual: true, inicio: L.fmtData(Date.now()), vencimento: L.fmtData(r.validoAte) });
            await L.excluirDocs([b.id]);
            return L.resp(200, { ok: true, nome: r.dados.nome, email: r.dados.email, whatsapp: ped.dados.whatsapp || "", codigo: r.codigo, vencimento: L.fmtData(r.validoAte), criado: r.novo, versao: VERSAO });
        }
        const meses = Math.round(Number(b.meses));
        if (!(meses >= 1 && meses <= 36)) return L.resp(400, { erro: "Meses deve ser de 1 a 36." });
        if (b.acao === "criar") {
            const nome = String(b.nome || "").trim().replace(/\s+/g, " ").slice(0, 80);
            if (nome.length < 3 || !L.emailValido(String(b.email || "").trim())) return L.resp(400, { erro: "Informe nome completo e e-mail válido." });
            const r = await L.ativarOuRenovar({ nome, email: String(b.email).trim(), meses, marca: { liberadoManual: true } });
            await L.avisarPlanilha({ acao: r.novo ? "ativacao" : "renovacao", syncId: r.dados.syncId || "", nome: r.dados.nome, email: r.dados.email, codigo: r.codigo,
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
                await L.avisarPlanilha({ acao: "renovacao", syncId: c.dados.syncId || "", nome: c.dados.nome, email: c.dados.email, codigo: c.dados.codigo,
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
