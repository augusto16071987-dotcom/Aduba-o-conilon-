// netlify/functions/sync.js
// Sincronização protegida: o app NÃO fala mais direto com o Firestore. Todo pedido traz o
// código de ativação; o servidor confere o código, descobre o "sitio-xxxx" dele e só
// mexe nos documentos daquele cliente.
// Corpo: { codigo, acao: "ler"|"quando"|"gravar", chave, itens?, em? }
//    ou  { senha, acao: "ler", syncId, chave }   (tela de Suporte, somente leitura)
const crypto = require("crypto");
const L = require("./lib/firestore");
const A = require("./lib/anexos-lib");

const COL = "nutricafe_dados";
const cache = new Map(); // codigo -> { t, c }  (evita reler o cadastro a cada pedido)

function docId(syncId, chave) { return (String(syncId) + "--" + String(chave)).replace(/[^a-zA-Z0-9_-]/g, "_"); }
function chaveOk(k) { return typeof k === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(k) && !/^assinatura/i.test(k); }

async function cliente(codigo) {
    const hit = cache.get(codigo);
    if (hit && Date.now() - hit.t < 60000) return hit.c;
    const c = await L.lerDoc("c_" + codigo);
    if (c) cache.set(codigo, { t: Date.now(), c });
    return c;
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const b = L.parseBody(event);
        const acao = b.acao;
        if (["ler", "quando", "gravar"].indexOf(acao) < 0) return L.resp(400, { erro: "Ação inválida." });
        if (!chaveOk(b.chave)) return L.resp(400, { erro: "Chave inválida." });

        let syncId = "";
        if (b.senha !== undefined) {
            // Suporte: só leitura, com a senha do painel
            const senha = process.env.SUPORTE_SENHA;
            if (!senha) return L.resp(500, { erro: "SUPORTE_SENHA não configurada no servidor." });
            const igual = typeof b.senha === "string" && b.senha.length === senha.length &&
                crypto.timingSafeEqual(Buffer.from(b.senha), Buffer.from(senha));
            if (!igual) { await new Promise(r => setTimeout(r, 1000)); return L.resp(401, { erro: "Senha incorreta." }); }
            if (acao === "gravar") return L.resp(403, { erro: "Suporte é somente leitura." });
            if (!L.syncIdValido(b.syncId)) return L.resp(400, { erro: "ID inválido." });
            syncId = String(b.syncId);
        } else {
            const codigo = L.normalizaCodigo(b.codigo);
            if (!codigo) return L.resp(401, { erro: "Código inválido." });
            const c = await cliente(codigo);
            if (!c || !c.dados.syncId) return L.resp(401, { erro: "Código não encontrado." });
            if (acao === "gravar" && !(Number(c.dados.validoAte) > Date.now())) return L.resp(403, { erro: "Assinatura vencida." });
            syncId = c.dados.syncId;
        }

        const id = docId(syncId, b.chave);
        const url = "/" + COL + "/" + encodeURIComponent(id);

        if (acao === "gravar") {
            if (typeof b.itens !== "string" || b.itens.length > 900000) return L.resp(400, { erro: "Dados inválidos ou grandes demais." });
            const em = typeof b.em === "string" && b.em.length <= 40 ? b.em : new Date().toISOString();
            const r = await A.api(url + "?updateMask.fieldPaths=itens&updateMask.fieldPaths=atualizadoEm", {
                method: "PATCH",
                body: JSON.stringify({ fields: { itens: { stringValue: b.itens }, atualizadoEm: { stringValue: em } } }),
            });
            if (!r.ok) return L.resp(502, { erro: "Falha ao gravar na nuvem." });
            return L.resp(200, { ok: true });
        }

        const r = await A.api(url + (acao === "quando" ? "?mask.fieldPaths=atualizadoEm" : ""));
        if (r.status === 404) return L.resp(200, { ok: true, existe: false, em: "" });
        if (!r.ok) return L.resp(502, { erro: "Falha ao ler da nuvem." });
        const j = await r.json();
        const f = j.fields || {};
        const em = (f.atualizadoEm && f.atualizadoEm.stringValue) || "";
        if (acao === "quando") return L.resp(200, { ok: true, existe: true, em });
        return L.resp(200, { ok: true, existe: true, em, itens: (f.itens && f.itens.stringValue) || "" });
    } catch (e) {
        console.error("sync:", e);
        return L.resp(500, { erro: "Erro no servidor." });
    }
};
