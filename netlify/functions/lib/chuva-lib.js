// netlify/functions/lib/chuva-lib.js
// Ajudantes do pluviômetro (guardados no mesmo Firestore, documento r_<CODIGO>).
// Fica em lib/ de propósito: o Netlify NÃO trata isto como função.
const L = require("./firestore");

const LIMITE_PADRAO = 12;
const MAX_DIAS = 400;

// código do aparelho: 8 letras/números (ex.: K7QM-4TXA), sem 0/O/1/I
function normalizaCodigo(c) { return L.normalizaCodigo(c); }
function idDoc(codigo) { return "r_" + codigo.replace("-", ""); }

function hojeBR(agora) {
    const d = new Date((agora || Date.now()) - 3 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
}
function dataBR(ms) { return hojeBR(ms); }

function lerDias(dados) {
    try { const o = JSON.parse(dados.dias || "{}"); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; }
}
function numero(v, padrao) { const n = Number(String(v).replace(",", ".")); return isFinite(n) ? n : padrao; }
function configDe(dados) {
    let limite = numero(dados.limite, LIMITE_PADRAO);
    if (!(limite > 0)) limite = LIMITE_PADRAO;
    const dias = Number(dados.diasConsiderados) === 2 ? 2 : 1;
    return { limite, dias };
}
function podarDias(mapa) {
    const chaves = Object.keys(mapa).sort();
    while (chaves.length > MAX_DIAS) delete mapa[chaves.shift()];
    return mapa;
}

// lê o aparelho (null se nunca se comunicou)
async function lerAparelho(codigo) {
    const d = await L.lerDoc(idDoc(codigo));
    return d;
}

// Atualiza com tentativas (conflito = outra gravação ao mesmo tempo). fn(dadosAtuais) -> campos a gravar.
async function atualizar(codigo, fn) {
    for (let t = 0; t < 5; t++) {
        const atual = await L.lerDoc(idDoc(codigo));
        const dados = atual ? atual.dados : {};
        const novos = fn(dados, !atual);
        const g = await L.gravar([atual
            ? { id: idDoc(codigo), dados: novos, updateTime: atual.updateTime }
            : { id: idDoc(codigo), dados: Object.assign({ limite: String(LIMITE_PADRAO), diasConsiderados: 1, criadoEm: Date.now() }, novos), criar: true }]);
        if (g.ok) return true;
    }
    throw new Error("conflito ao gravar chuva");
}

function lista(mapa, desde) {
    return Object.keys(mapa).filter((d) => d >= desde).sort().map((d) => ({ data: d, mm: mapa[d] }));
}
function statusIrrigacao(dados, agora) {
    const mapa = lerDias(dados);
    const cfg = configDe(dados);
    const hoje = hojeBR(agora);
    const ontem = hojeBR((agora || Date.now()) - 86400000);
    const mmHoje = mapa[hoje] || 0;
    const mmOntem = mapa[ontem] || 0;
    const considerado = cfg.dias === 2 ? mmHoje + mmOntem : mmHoje;
    return {
        ok: true, pode_irrigar: considerado < cfg.limite,
        mm_hoje: mmHoje, mm_ontem: mmOntem, mm_considerado: Math.round(considerado * 10) / 10,
        limite: cfg.limite, dias_considerados: cfg.dias,
        ultimo_contato: dados.ultimo ? new Date(Number(dados.ultimo)).toISOString() : "",
    };
}

module.exports = { LIMITE_PADRAO, normalizaCodigo, idDoc, hojeBR, dataBR, lerDias, configDe, podarDias, lerAparelho, atualizar, lista, statusIrrigacao, numero };
