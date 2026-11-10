// netlify/functions/excluir-conta.js
// Exclusão de conta e dados (LGPD / exigência da Play Store). O cliente prova que é o dono com o CÓDIGO DE ATIVAÇÃO.
// Corpo: { codigo, confirmar: "EXCLUIR" }
// Apaga: cadastro (c_), índice do e-mail (e_), dados sincronizados na nuvem (nutricafe_dados, incl. bulas/fotos),
// e as mensagens da Comunidade escritas com o nome do cadastro (e seus arquivos).
// Mantém só os registros de pagamento (o_/p_), exigidos por obrigação fiscal.
const L = require("./lib/firestore");
const A = require("./lib/anexos-lib");

const COL_DADOS = "nutricafe_dados";
const COL_CHAT = "nutricafe_comunidade";

async function consultar(colecao, filtro) {
    const q = { structuredQuery: { from: [{ collectionId: colecao }], where: filtro,
        select: { fields: [{ fieldPath: "__name__" }, { fieldPath: "arquivoId" }, { fieldPath: "arquivoPartes" }] }, limit: 500 } };
    const r = await A.api(":runQuery", { method: "POST", body: JSON.stringify(q) });
    if (!r.ok) throw new Error("runQuery " + colecao + " " + r.status);
    const linhas = await r.json();
    return (linhas || []).filter(l => l.document).map(l => l.document);
}
async function apagar(caminho) { const r = await A.api("/" + caminho, { method: "DELETE" }); return r.ok || r.status === 404; }

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const b = L.parseBody(event);
        const cod = L.normalizaCodigo(b.codigo);
        if (!cod) return L.resp(400, { erro: "Digite o código de ativação (ex.: K7QM-4TXA)." });
        if (String(b.confirmar || "").trim().toUpperCase() !== "EXCLUIR") return L.resp(400, { erro: "Confirmação ausente." });
        const cliente = await L.lerDoc("c_" + cod);
        if (!cliente || !cliente.dados) { await new Promise(r => setTimeout(r, 800)); return L.resp(404, { erro: "Código não encontrado." }); }
        const d = cliente.dados;
        const out = { dados: 0, mensagens: 0, arquivos: 0 };

        // 1) dados sincronizados (documentos "<syncId>--<chave>")
        const syncId = String(d.syncId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
        if (syncId.length >= 6) {
            const prefixo = syncId + "--";
            const sup = prefixo.slice(0, -1) + ".";   // '.' vem logo depois de '-'
            const ref = (id) => A.RAIZ + "/" + COL_DADOS + "/" + id;
            const docs = await consultar(COL_DADOS, { compositeFilter: { op: "AND", filters: [
                { fieldFilter: { field: { fieldPath: "__name__" }, op: "GREATER_THAN_OR_EQUAL", value: { referenceValue: ref(prefixo) } } },
                { fieldFilter: { field: { fieldPath: "__name__" }, op: "LESS_THAN", value: { referenceValue: ref(sup) } } } ] } });
            for (const doc of docs) { if (await apagar(COL_DADOS + "/" + doc.name.split("/").pop())) out.dados++; }
        }
        // 2) mensagens da Comunidade com o nome do cadastro
        const nome = String(d.nome || "").trim();
        if (nome.length >= 3) {
            const msgs = await consultar(COL_CHAT, { fieldFilter: { field: { fieldPath: "autorNome" }, op: "EQUAL", value: { stringValue: nome } } });
            for (const m of msgs) {
                const f = m.fields || {};
                const aid = f.arquivoId && f.arquivoId.stringValue;
                const np = Number(f.arquivoPartes && f.arquivoPartes.stringValue) || 0;
                if (aid && /^[A-Za-z0-9]+$/.test(aid)) for (let i = 0; i < Math.min(np, 20); i++) { if (await apagar(COL_CHAT + "/arq_" + aid + "_" + i)) out.arquivos++; }
                if (await apagar(COL_CHAT + "/" + m.name.split("/").pop())) out.mensagens++;
            }
        }
        // 3) por último: o e-mail e o cadastro (assim dá pra tentar de novo se algo falhar antes)
        if (d.email) { try { await apagar("nutricafe_assinaturas/" + L.idEmail(L.emailCanonico(d.email))); } catch (e) { } }
        await apagar("nutricafe_assinaturas/c_" + cod);
        return L.resp(200, { ok: true, apagado: out });
    } catch (e) {
        console.error("excluir-conta:", e);
        return L.resp(500, { erro: "Não consegui concluir agora. Tente de novo em alguns minutos ou fale com o suporte." });
    }
};
