// netlify/functions/chuva.js
// Usado pelo APP e pelo controle da IRRIGAÇÃO. O "codigo" do pluviômetro é a senha de acesso.
//   POST/GET { codigo }                         -> chuva dos dias + limite + último contato
//   POST/GET { codigo, acao:"irrigar" }         -> { pode_irrigar, mm_hoje, ... }
//   POST     { codigo, acao:"config", limite, dias_considerados } -> muda o limite
const L = require("./lib/firestore");
const C = require("./lib/chuva-lib");

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    try {
        const q = event.httpMethod === "GET" ? (event.queryStringParameters || {}) : L.parseBody(event);
        const codigo = C.normalizaCodigo(q.codigo);
        if (!codigo) return L.resp(400, { ok: false, erro: "Código inválido. Ele tem 8 letras/números (ex.: K7QM-4TXA) e está na etiqueta do pluviômetro." });
        const d = await C.lerAparelho(codigo);
        if (!d) return L.resp(404, { ok: false, erro: "Pluviômetro não encontrado. Confira o código, ligue o aparelho, conecte ao Wi-Fi e espere uns 2 minutos." });
        const agora = Date.now();

        if (q.acao === "irrigar") return L.resp(200, C.statusIrrigacao(d.dados, agora));

        if (q.acao === "config") {
            if (event.httpMethod !== "POST") return L.resp(405, { ok: false, erro: "Use POST." });
            const limite = C.numero(q.limite, NaN);
            const dias = Number(q.dias_considerados) === 2 ? 2 : 1;
            if (!isFinite(limite) || limite <= 0 || limite > 200) return L.resp(400, { ok: false, erro: "Limite entre 1 e 200 mm." });
            await C.atualizar(codigo, () => ({ limite: String(Math.round(limite * 10) / 10), diasConsiderados: dias }));
            return L.resp(200, { ok: true, limite: Math.round(limite * 10) / 10, dias_considerados: dias });
        }

        const dias = Math.min(400, Math.max(1, Number(q.dias) || 400));
        const desde = C.hojeBR(agora - dias * 86400000);
        const cfg = C.configDe(d.dados);
        return L.resp(200, {
            ok: true, hoje: C.hojeBR(agora), dias: C.lista(C.lerDias(d.dados), desde),
            limite: cfg.limite, dias_considerados: cfg.dias,
            ultimo_contato: d.dados.ultimo ? new Date(Number(d.dados.ultimo)).toISOString() : "",
        });
    } catch (e) {
        console.error("chuva:", e);
        return L.resp(500, { ok: false, erro: "Erro no servidor. Tente novamente." });
    }
};
