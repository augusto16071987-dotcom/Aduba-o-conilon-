// netlify/functions/chuva-registrar.js
// Chamado pelo ESP32 do pluviômetro.
// POST { codigo, fabrica, data, pulsos, mm }  -> grava o TOTAL do dia (repetir não duplica)
// POST { codigo, fabrica, ping:true }         -> só avisa "estou vivo" (e cria o aparelho no 1º contato)
// "fabrica" é uma chave que vai no programa do aparelho (variável PLUVIOMETRO_CHAVE no Netlify):
// barra quem não é aparelho seu de criar registros à toa.
const L = require("./lib/firestore");
const C = require("./lib/chuva-lib");

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const b = L.parseBody(event);
        const esperado = process.env.PLUVIOMETRO_CHAVE || "";
        if (!esperado || b.fabrica !== esperado) return L.resp(403, { erro: "chave" });
        const codigo = C.normalizaCodigo(b.codigo);
        if (!codigo) return L.resp(400, { erro: "codigo" });
        const agora = Date.now();

        if (b.ping) {
            await C.atualizar(codigo, () => ({ ultimo: agora }));
            return L.resp(200, { ok: true });
        }

        const data = String(b.data || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return L.resp(400, { erro: "data" });
        // só aceita hoje, ontem ou anteontem (relógio do aparelho com defeito não suja o histórico)
        const aceitas = [0, 1, 2].map((i) => C.hojeBR(agora - i * 86400000));
        if (aceitas.indexOf(data) < 0) return L.resp(400, { erro: "data fora da janela" });
        const mm = Math.round(C.numero(b.mm, NaN) * 10) / 10;
        const pulsos = Math.round(Number(b.pulsos) || 0);
        if (!isFinite(mm) || mm < 0 || mm > 1000) return L.resp(400, { erro: "mm" });

        await C.atualizar(codigo, (dados) => {
            const mapa = C.lerDias(dados);
            mapa[data] = mm;
            return { dias: JSON.stringify(C.podarDias(mapa)), ultimo: agora, ultimoPulsos: pulsos };
        });
        return L.resp(200, { ok: true });
    } catch (e) {
        console.error("chuva-registrar:", e);
        return L.resp(500, { erro: "Erro no servidor." });
    }
};
