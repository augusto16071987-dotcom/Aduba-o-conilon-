// netlify/functions/lib/anexos-lib.js
// Espaço do Firestore: medir (estimado), limpar anexos antigos da Comunidade e avisar quando está cheio.
// Guarda a configuração no documento "config_anexos" (mesma coleção das assinaturas).
const crypto = require("crypto");
const L = require("./firestore");

const PROJETO = "backup-bb0d9";
const RAIZ = "projects/" + PROJETO + "/databases/(default)/documents";
const BASE = "https://firestore.googleapis.com/v1/" + RAIZ;
const COL_CHAT = "nutricafe_comunidade";
const COLS_MEDIR = ["nutricafe_comunidade", "nutricafe_dados", "nutricafe_assinaturas"];
const ID_CONFIG = "config_anexos";
const LIMITE_GRATIS_MB = 1024;      // plano Spark: 1 GiB
const ORCAMENTO_MS = 7000;          // a função do Netlify para em ~10 s

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
async function api(path, opts) {
    const r = await fetch(BASE + path, Object.assign({ headers: { Authorization: "Bearer " + await token(), "Content-Type": "application/json" } }, opts || {}));
    return r;
}

// ---- configuração ----
const PADRAO = { diasAnexos: 0, limiteMb: LIMITE_GRATIS_MB, avisoPct: 80 };
async function lerConfig() {
    const d = await L.lerDoc(ID_CONFIG);
    return Object.assign({}, PADRAO, d ? d.dados : {});
}
async function salvarConfig(mudancas) {
    const atual = await lerConfig();
    const novo = Object.assign({}, atual, mudancas);
    await L.gravar([{ id: ID_CONFIG, dados: novo }]);
    return novo;
}
const DIAS_VALIDOS = [0, 30, 60, 90, 180, 365];

// ---- medir ----
function tamanhoDoc(doc) { return Buffer.byteLength(JSON.stringify(doc.fields || {})) + String(doc.name || "").length + 32; }
// Avança a medição por até ORCAMENTO_MS. O ponto onde parou fica no config (medEstado) pra continuar na próxima chamada.
async function medirPasso(reiniciar) {
    const cfg = await lerConfig();
    let est = null;
    if (!reiniciar && cfg.medEstado) { try { est = JSON.parse(cfg.medEstado); } catch (e) { } }
    if (!est) est = { i: 0, t: "", acc: {}, ini: Date.now() };
    const inicio = Date.now();
    while (est.i < COLS_MEDIR.length && Date.now() - inicio < ORCAMENTO_MS) {
        const col = COLS_MEDIR[est.i];
        const r = await api("/" + col + "?pageSize=25" + (est.t ? "&pageToken=" + encodeURIComponent(est.t) : ""));
        if (!r.ok) throw new Error("LIST " + col + " " + r.status);
        const d = await r.json();
        let b = 0; for (const doc of d.documents || []) b += tamanhoDoc(doc);
        est.acc[col] = (est.acc[col] || 0) + b;
        est.t = d.nextPageToken || "";
        if (!est.t) est.i++;
    }
    if (est.i >= COLS_MEDIR.length) {
        const total = COLS_MEDIR.reduce((s, c) => s + (est.acc[c] || 0), 0);
        const novo = await salvarConfig({
            medEstado: "", medidoEm: new Date().toISOString(), bytesTotal: total,
            bytesComunidade: est.acc[COL_CHAT] || 0, bytesDados: est.acc.nutricafe_dados || 0, bytesAssin: est.acc.nutricafe_assinaturas || 0,
        });
        return { feito: true, config: novo };
    }
    const parcial = COLS_MEDIR.reduce((s, c) => s + (est.acc[c] || 0), 0);
    const novo = await salvarConfig({ medEstado: JSON.stringify(est) });
    return { feito: false, parcialBytes: parcial, config: novo };
}

// ---- limpar anexos antigos da Comunidade ----
async function apagarDoc(col, id) { const r = await api("/" + col + "/" + id, { method: "DELETE" }); return r.ok || r.status === 404; }
async function limparAnexos(dias) {
    const corte = Date.now() - dias * 86400000;
    const umaHora = Date.now() - 3600000;
    const msgs = [], pedacos = [];
    let t = "";
    const inicio = Date.now();
    do {
        const r = await api("/" + COL_CHAT + "?pageSize=25" + (t ? "&pageToken=" + encodeURIComponent(t) : ""));
        if (!r.ok) throw new Error("LIST chat " + r.status);
        const d = await r.json();
        for (const doc of d.documents || []) {
            const id = doc.name.split("/").pop();
            if (id.indexOf("arq_") === 0) pedacos.push({ id, criado: Date.parse(doc.createTime) || 0, bytes: tamanhoDoc(doc) });
            else {
                const f = doc.fields || {};
                msgs.push({
                    id, criado: Date.parse((f.criadoEm && f.criadoEm.stringValue) || "") || Date.parse(doc.createTime) || 0,
                    temAnexo: !!(f.fotoBase64 || f.arquivoBase64 || f.arquivoId), arquivoId: f.arquivoId ? f.arquivoId.stringValue : "",
                    partes: f.arquivoPartes ? Number(f.arquivoPartes.stringValue) || 0 : 0,
                    texto: f.texto ? f.texto.stringValue : "", bytes: tamanhoDoc(doc),
                });
            }
        }
        t = d.nextPageToken || "";
        if (Date.now() - inicio > 20000) break;
    } while (t);
    let removidos = 0, liberado = 0, orfaos = 0;
    const idsVivos = new Set(msgs.filter(m => m.arquivoId).map(m => m.arquivoId));
    // 1) anexos velhos
    if (dias > 0) {
        for (const m of msgs) {
            if (!m.temAnexo || !m.criado || m.criado >= corte) continue;
            if (m.arquivoId) for (let i = 0; i < Math.min(m.partes, 20); i++) { await apagarDoc(COL_CHAT, "arq_" + m.arquivoId + "_" + i); }
            const texto = (m.texto ? m.texto + "\n" : "") + "📎 (anexo removido pelo tempo de guarda)";
            const mask = ["fotoBase64", "arquivoBase64", "arquivoNome", "arquivoId", "arquivoPartes", "tipo", "texto"].map(x => "updateMask.fieldPaths=" + x).join("&");
            const r = await api("/" + COL_CHAT + "/" + m.id + "?" + mask, { method: "PATCH", body: JSON.stringify({ fields: { tipo: { stringValue: "texto" }, texto: { stringValue: texto } } }) });
            if (r.ok) { removidos++; liberado += m.bytes; idsVivos.delete(m.arquivoId); }
            if (Date.now() - inicio > 24000) break;
        }
    }
    // 2) pedaços órfãos (mensagem apagada) com mais de 1 hora
    for (const p of pedacos) {
        const mt = /^arq_([A-Za-z0-9]+)_\d+$/.exec(p.id);
        if (!mt || p.criado > umaHora) continue;
        if (idsVivos.has(mt[1])) continue;
        // se a mensagem ainda existe mas o anexo acabou de ser removido, idsVivos já não tem: também é lixo
        if (await apagarDoc(COL_CHAT, p.id)) { orfaos++; liberado += p.bytes; }
        if (Date.now() - inicio > 26000) break;
    }
    const info = removidos + " anexo(s) velho(s), " + orfaos + " pedaço(s) solto(s), ~" + Math.round(liberado / 1024) + " KB liberados";
    await salvarConfig({ ultimaLimpeza: new Date().toISOString(), ultimaLimpezaInfo: info });
    return { removidos, orfaos, liberadoBytes: liberado, info };
}

// ---- resumo pro app ----
function resumo(cfg) {
    const limite = Number(cfg.limiteMb) * 1048576;
    const usado = Number(cfg.bytesTotal) || 0;
    const pct = limite > 0 ? usado / limite * 100 : 0;
    return {
        diasAnexos: Number(cfg.diasAnexos) || 0, limiteMb: Number(cfg.limiteMb), avisoPct: Number(cfg.avisoPct),
        medidoEm: cfg.medidoEm || "", bytesTotal: usado, bytesComunidade: Number(cfg.bytesComunidade) || 0, bytesDados: Number(cfg.bytesDados) || 0, bytesAssin: Number(cfg.bytesAssin) || 0,
        pct: Math.round(pct * 10) / 10, alerta: !!cfg.medidoEm && pct >= Number(cfg.avisoPct), medindo: !!cfg.medEstado,
        ultimaLimpeza: cfg.ultimaLimpeza || "", ultimaLimpezaInfo: cfg.ultimaLimpezaInfo || "",
    };
}

// Rotina diária (chamada pelo lembretes.js): limpa conforme a configuração e avança a medição.
async function rotinaDiaria() {
    const cfg = await lerConfig();
    let limpeza = null;
    if (Number(cfg.diasAnexos) > 0) limpeza = await limparAnexos(Number(cfg.diasAnexos));
    else limpeza = await limparAnexos(0);   // sem prazo: só tira pedaços soltos
    const m = await medirPasso(false);
    // aviso por e-mail (no máximo 1 a cada 7 dias) quando o espaço passa do limite de alerta
    let aviso = "";
    try {
        const c2 = await lerConfig();
        const r = resumo(c2);
        const ultimo = Number(c2.avisoEmailEm) || 0;
        if (r.alerta && Date.now() - ultimo > 7 * 86400000) {
            const env = await L.avisarPlanilha({ acao: "aviso_espaco", pct: r.pct, usadoMb: Math.round(r.bytesTotal / 1048576), limiteMb: r.limiteMb, comunidadeMb: Math.round(r.bytesComunidade / 1048576), dadosMb: Math.round(r.bytesDados / 1048576) });
            if (env.ok) { await salvarConfig({ avisoEmailEm: Date.now() }); aviso = "enviado"; } else aviso = "falhou";
        }
    } catch (e) { console.error("aviso espaco:", e); aviso = "erro"; }
    return { limpeza: limpeza && limpeza.info, medicao: m.feito ? "completa" : "em andamento", aviso };
}

module.exports = { api, BASE, RAIZ, lerConfig, salvarConfig, DIAS_VALIDOS, medirPasso, limparAnexos, resumo, rotinaDiaria, LIMITE_GRATIS_MB };
