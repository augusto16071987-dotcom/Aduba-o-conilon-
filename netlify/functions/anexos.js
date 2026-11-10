// netlify/functions/anexos.js
// Painel de Suporte: espaço usado, tempo de guarda dos anexos da Comunidade e limpeza.
// Corpo: { senha, acao: "status" | "config" | "medir" | "limpar", dias, limiteMb, reiniciar }
const L = require("./lib/firestore");
const A = require("./lib/anexos-lib");

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const b = L.parseBody(event);
        const senha = process.env.SUPORTE_SENHA;
        if (!senha) return L.resp(500, { erro: "SUPORTE_SENHA não configurada no servidor." });
        const igual = typeof b.senha === "string" && b.senha.length === senha.length &&
            require("crypto").timingSafeEqual(Buffer.from(b.senha), Buffer.from(senha));
        if (!igual) { await new Promise(r => setTimeout(r, 1000)); return L.resp(401, { erro: "Senha incorreta." }); }

        if (b.acao === "status") return L.resp(200, { ok: true, resumo: A.resumo(await A.lerConfig()) });
        if (b.acao === "config") {
            const mud = {};
            if (b.dias !== undefined) {
                const d = Number(b.dias);
                if (A.DIAS_VALIDOS.indexOf(d) < 0) return L.resp(400, { erro: "Prazo inválido." });
                mud.diasAnexos = d;
            }
            if (b.limiteMb !== undefined) {
                const m = Number(b.limiteMb);
                if (!(m >= 50 && m <= 102400)) return L.resp(400, { erro: "Limite entre 50 MB e 100 GB." });
                mud.limiteMb = Math.round(m);
            }
            return L.resp(200, { ok: true, resumo: A.resumo(await A.salvarConfig(mud)) });
        }
        if (b.acao === "medir") {
            const r = await A.medirPasso(!!b.reiniciar);
            return L.resp(200, { ok: true, feito: r.feito, parcialBytes: r.parcialBytes || 0, resumo: A.resumo(r.config) });
        }
        if (b.acao === "limpar") {
            const cfg = await A.lerConfig();
            const dias = b.dias !== undefined ? Number(b.dias) : Number(cfg.diasAnexos);
            if (A.DIAS_VALIDOS.indexOf(dias) < 0) return L.resp(400, { erro: "Prazo inválido." });
            const r = await A.limparAnexos(dias);
            return L.resp(200, { ok: true, limpeza: r, resumo: A.resumo(await A.lerConfig()) });
        }
        return L.resp(400, { erro: "Ação inválida." });
    } catch (e) {
        console.error("anexos:", e);
        return L.resp(500, { erro: "Erro no servidor." });
    }
};
