// netlify/functions/lib/firestore.js
// Ajudantes compartilhados (acesso "de servidor" ao Firestore, e-mail, planos).
// Fica na subpasta lib/ de propósito: o Netlify NÃO trata isto como função.

const crypto = require("crypto");

const PROJETO = "backup-bb0d9";
const COLECAO = "nutricafe_assinaturas";
const RAIZ = "projects/" + PROJETO + "/databases/(default)/documents";
const BASE = "https://firestore.googleapis.com/v1/" + RAIZ;

// Preços e prazos SÓ existem aqui (servidor). O app nunca manda valor.
const PLANOS = {
    mensal:    { meses: 1,  preco: 9.9,  titulo: "NutriCafé - 1 mês" },
    semestral: { meses: 6,  preco: 54.9, titulo: "NutriCafé - 6 meses" },
    anual:     { meses: 12, preco: 99.9, titulo: "NutriCafé - 1 ano" },
};

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
};
function resp(status, obj) { return { statusCode: status, headers: CORS, body: JSON.stringify(obj) }; }

function b64url(x) {
    return Buffer.from(x).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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

function enc(v) {
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return { integerValue: String(Math.round(v)) };
    return { stringValue: String(v == null ? "" : v) };
}
function toFields(o) { const f = {}; for (const k of Object.keys(o)) f[k] = enc(o[k]); return f; }
function fromFields(f) {
    const o = {};
    for (const k of Object.keys(f || {})) {
        const v = f[k];
        if ("stringValue" in v) o[k] = v.stringValue;
        else if ("integerValue" in v) o[k] = Number(v.integerValue);
        else if ("booleanValue" in v) o[k] = v.booleanValue;
    }
    return o;
}

async function lerDoc(id) {
    const r = await fetch(BASE + "/" + COLECAO + "/" + encodeURIComponent(id), { headers: { Authorization: "Bearer " + await token() } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("Firestore GET " + r.status);
    const d = await r.json();
    return { dados: fromFields(d.fields), updateTime: d.updateTime };
}

async function listarTodos(prefixo) {
    const out = []; let pageToken = "";
    do {
        const r = await fetch(BASE + "/" + COLECAO + "?pageSize=300" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""),
            { headers: { Authorization: "Bearer " + await token() } });
        if (!r.ok) throw new Error("Firestore LIST " + r.status);
        const d = await r.json();
        for (const doc of d.documents || []) {
            const id = doc.name.split("/").pop();
            if (!prefixo || id.indexOf(prefixo) === 0) out.push({ id, dados: fromFields(doc.fields), updateTime: doc.updateTime });
        }
        pageToken = d.nextPageToken || "";
    } while (pageToken);
    return out;
}

// writes: [{ id, dados, criar:true } | { id, dados, updateTime }]
// Tudo-ou-nada. Devolve { ok:true } ou { ok:false, conflito:true }.
async function gravar(writes) {
    const body = { writes: writes.map(w => {
        const x = { update: { name: RAIZ + "/" + COLECAO + "/" + w.id, fields: toFields(w.dados) } };
        if (w.criar) x.currentDocument = { exists: false };
        else if (w.updateTime) { x.currentDocument = { updateTime: w.updateTime }; x.updateMask = { fieldPaths: Object.keys(w.dados) }; }
        return x;
    }) };
    const r = await fetch(BASE + ":commit", {
        method: "POST", headers: { Authorization: "Bearer " + await token(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (r.ok) return { ok: true };
    const t = await r.text();
    if (r.status === 409 || r.status === 400 && /ALREADY_EXISTS|FAILED_PRECONDITION/.test(t) || /ALREADY_EXISTS|FAILED_PRECONDITION/.test(t)) return { ok: false, conflito: true };
    throw new Error("Firestore COMMIT " + r.status + " " + t.slice(0, 200));
}

// Apaga documentos (ids) numa só operação.
async function excluirDocs(ids) {
    const body = { writes: ids.map(id => ({ delete: RAIZ + "/" + COLECAO + "/" + id })) };
    const r = await fetch(BASE + ":commit", {
        method: "POST", headers: { Authorization: "Bearer " + await token(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("Firestore DELETE " + r.status + " " + (await r.text()).slice(0, 200));
    return { ok: true };
}

// ---------- utilidades ----------
function emailCanonico(email) {
    let e = String(email || "").trim().toLowerCase();
    const m = e.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
    if (!m) return "";
    let [, u, d] = m;
    u = u.split("+")[0];
    if (d === "googlemail.com") d = "gmail.com";
    if (d === "gmail.com") u = u.replace(/\./g, "");
    if (!u) return "";
    return u + "@" + d;
}
function emailValido(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(e || "").trim()) && e.length <= 120; }
function idEmail(canon) { return "e_" + crypto.createHash("sha256").update(canon).digest("hex").slice(0, 40); }

const ALFA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function novoCodigo() {
    const b = crypto.randomBytes(8); let s = "";
    for (let i = 0; i < 8; i++) s += ALFA[b[i] % ALFA.length];
    return s.slice(0, 4) + "-" + s.slice(4);
}
// Código de recuperação dos dados na nuvem (liga o cadastro aos dados do app). Ex.: sitio-k4m9x2qp
function novoSyncId() {
    const al = "abcdefghjkmnpqrstuvwxyz23456789"; const b = crypto.randomBytes(8); let s = "";
    for (let i = 0; i < 8; i++) s += al[b[i] % al.length];
    return "sitio-" + s;
}
function syncIdValido(v) { return /^[A-Za-z0-9-]{4,40}$/.test(String(v || "")); }
function normalizaCodigo(c) {
    const s = String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return s.length === 8 ? s.slice(0, 4) + "-" + s.slice(4) : "";
}
function somaMeses(msBase, meses) {
    const d = new Date(msBase); const dia = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + meses);
    const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(dia, ultimo));
    return d.getTime();
}
function fmtData(ms) {
    const d = new Date(ms - 3 * 3600 * 1000); // Brasília
    const p = n => String(n).padStart(2, "0");
    return p(d.getUTCDate()) + "/" + p(d.getUTCMonth() + 1) + "/" + d.getUTCFullYear();
}

// Planilha + e-mail via Google Apps Script. Nunca derruba o fluxo principal.
async function avisarPlanilha(payload) {
    const url = process.env.APPS_SCRIPT_URL;
    if (!url) return { ok: false, motivo: "APPS_SCRIPT_URL ausente" };
    try {
        const r = await fetch(url, {
            method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(Object.assign({ segredo: process.env.APPS_SCRIPT_SEGREDO || "" }, payload)),
            redirect: "follow",
        });
        const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
        return { ok: !!j.ok, motivo: j.erro || "" };
    } catch (e) { return { ok: false, motivo: String(e.message || e) }; }
}

const INTERVALO_REENVIO_MS = 2 * 60 * 1000;

// Cria o cliente (código novo) com N meses a partir de agora. Se o e-mail já
// existe, soma os meses ao código existente. Devolve { codigo, novo, validoAte, dados }.
// extras = gravações adicionais (ex.: p_<pagamento>, pedido) feitas na MESMA operação atômica.
async function ativarOuRenovar({ nome, email, meses, extras, marca, whatsapp }) {
    const zap = zapNumero(whatsapp);
    const canon = emailCanonico(email);
    const idE = idEmail(canon);
    for (let t = 0; t < 5; t++) {
        const agora = Date.now();
        const ex = await lerDoc(idE);
        if (ex) {
            const c = await lerDoc("c_" + ex.dados.codigo);
            if (!c) throw new Error("cadastro inconsistente");
            const novo = somaMeses(Math.max(agora, Number(c.dados.validoAte) || 0), meses);
            const g = await gravar([].concat(extras || [], [{ id: "c_" + c.dados.codigo, updateTime: c.updateTime,
                dados: Object.assign({ validoAte: novo, ultimoPagamento: agora }, zap ? { whatsapp: zap } : {}, marca || {}) }]));
            if (g.ok) return { codigo: c.dados.codigo, novo: false, validoAte: novo, dados: c.dados };
            continue;
        }
        const codigo = novoCodigo();
        const validoAte = somaMeses(agora, meses);
        const dados = Object.assign({ codigo, syncId: novoSyncId(), nome, email, emailCanon: canon, inicio: agora, validoAte, criadoEm: agora, ultimoEnvio: agora, ultimoPagamento: agora }, zap ? { whatsapp: zap } : {}, marca || {});
        const g = await gravar([].concat(extras || [], [
            { id: idE, dados: { codigo, emailCanon: canon }, criar: true },
            { id: "c_" + codigo, dados, criar: true },
        ]));
        if (g.ok) return { codigo, novo: true, validoAte, dados };
    }
    throw new Error("conflito ao ativar");
}

// Telefone brasileiro só com dígitos, com DDI 55. Devolve "" se não parecer válido.
function zapNumero(v) {
    let d = String(v || "").replace(/\D/g, "");
    if (d.indexOf("55") === 0 && d.length >= 12) d = d.slice(2);
    if (d.length < 10 || d.length > 11) return "";
    return "55" + d;
}
function diasPara(validoAte, agora) { return Math.ceil((Number(validoAte) - (agora || Date.now())) / 86400000); }

function parseBody(event) {
    try { return JSON.parse(event.body || "{}"); } catch (e) { return {}; }
}
function statusDe(d, agora) {
    const ativo = Number(d.validoAte) > agora;
    return {
        nome: d.nome, email: d.email, codigo: d.codigo,
        validoAte: Number(d.validoAte), agora, ativo, trial: false,
        diasRestantes: ativo ? Math.ceil((Number(d.validoAte) - agora) / 86400000) : 0,
    };
}

module.exports = { zapNumero, diasPara, INTERVALO_REENVIO_MS, ativarOuRenovar, COLECAO, PLANOS, resp, lerDoc, listarTodos, gravar, emailCanonico, emailValido, idEmail,
    novoCodigo, novoSyncId, excluirDocs, syncIdValido, normalizaCodigo, somaMeses, fmtData, avisarPlanilha, parseBody, statusDe };
