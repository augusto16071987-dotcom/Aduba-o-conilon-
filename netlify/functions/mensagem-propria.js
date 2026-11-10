// netlify/functions/mensagem-propria.js
// Deixa o usuário APAGAR ou EDITAR a própria mensagem da Comunidade.
// Corpo: { codigo, id, acao: "apagar" | "editar", texto }
// Confere: (1) o código de ativação existe; (2) a mensagem foi escrita por
// esse cliente (o nome do autor na mensagem = o nome do cadastro do código).
const crypto = require("crypto");
const L = require("./lib/firestore");

const PROJETO = "backup-bb0d9";
const COLECAO_CHAT = "nutricafe_comunidade";
const RAIZ = "projects/" + PROJETO + "/databases/(default)/documents";
const BASE = "https://firestore.googleapis.com/v1/" + RAIZ;

function b64url(x) { return Buffer.from(x).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
let _tok = null, _tokExp = 0;
async function token() {
    if (_tok && Date.now() < _tokExp) return _tok;
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const agora = Math.floor(Date.now() / 1000);
    const sem = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify({
        iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore",
        aud: "https://oauth2.googleapis.com/token", exp: agora + 3600, iat: agora,
    }));
    const s = crypto.createSign("RSA-SHA256"); s.update(sem); s.end();
    const jwt = sem + "." + s.sign(sa.private_key).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + encodeURIComponent(jwt),
    });
    const d = await r.json();
    if (!d.access_token) throw new Error("Falha ao autenticar no Firebase");
    _tok = d.access_token; _tokExp = Date.now() + 50 * 60 * 1000;
    return _tok;
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const b = L.parseBody(event);
        const cod = L.normalizaCodigo(b.codigo);
        const id = String(b.id || "").replace(/[^A-Za-z0-9_-]/g, "");
        if (!cod || !id) return L.resp(400, { erro: "Dados inválidos." });
        if (b.acao !== "apagar" && b.acao !== "editar") return L.resp(400, { erro: "Ação inválida." });

        const cliente = await L.lerDoc("c_" + cod);
        if (!cliente || !cliente.dados || !cliente.dados.nome) return L.resp(403, { erro: "Código não encontrado." });

        const url = BASE + "/" + COLECAO_CHAT + "/" + id;
        const tk = await token();
        const g = await fetch(url, { headers: { Authorization: "Bearer " + tk } });
        if (g.status === 404) return L.resp(404, { erro: "Mensagem não existe mais." });
        if (!g.ok) throw new Error("GET " + g.status);
        const doc = await g.json();
        const autor = doc.fields && doc.fields.autorNome && doc.fields.autorNome.stringValue;
        if (!autor || autor !== cliente.dados.nome) return L.resp(403, { erro: "Só é possível mexer nas suas mensagens." });

        if (b.acao === "apagar") {
            const d = await fetch(url, { method: "DELETE", headers: { Authorization: "Bearer " + tk } });
            if (!d.ok) throw new Error("DELETE " + d.status);
            // arquivo grande: apaga também os pedaços
            const aid = doc.fields.arquivoId && doc.fields.arquivoId.stringValue;
            const np = Number(doc.fields.arquivoPartes && doc.fields.arquivoPartes.stringValue) || 0;
            if (aid && /^[A-Za-z0-9]+$/.test(aid)) {
                for (let i = 0; i < Math.min(np, 20); i++) {
                    await fetch(BASE + "/" + COLECAO_CHAT + "/arq_" + aid + "_" + i, { method: "DELETE", headers: { Authorization: "Bearer " + tk } }).catch(() => {});
                }
            }
            return L.resp(200, { ok: true });
        }
        const texto = String(b.texto == null ? "" : b.texto).trim().slice(0, 2000);
        const tipo = doc.fields.tipo && doc.fields.tipo.stringValue;
        if (!texto && tipo !== "foto" && tipo !== "arquivo") return L.resp(400, { erro: "Escreva algo." });
        const fields = { editadoEm: { stringValue: new Date().toISOString() } };
        const mask = ["editadoEm"];
        if (texto) { fields.texto = { stringValue: texto }; mask.push("texto"); }
        else mask.push("texto"); // vazio em foto/arquivo: remove a legenda
        const p = await fetch(url + "?" + mask.map(m => "updateMask.fieldPaths=" + m).join("&"), {
            method: "PATCH", headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" },
            body: JSON.stringify({ fields }),
        });
        if (!p.ok) throw new Error("PATCH " + p.status);
        return L.resp(200, { ok: true });
    } catch (e) {
        return L.resp(500, { erro: "Erro no servidor." });
    }
};
