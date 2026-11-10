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
        if (q.acao === "manual") {
            // lançamento feito à mão no NutriCafé: grava no servidor pra o app de irrigação enxergar
            if (event.httpMethod !== "POST") return L.resp(405, { ok: false, erro: "Use POST." });
            const data = String(q.data || "");
            if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || data > C.hojeBR(Date.now() + 86400000) || data < C.hojeBR(Date.now() - 400 * 86400000)) return L.resp(400, { ok: false, erro: "Data inválida." });
            const apagar = q.mm === null || q.mm === "" || q.mm === undefined;
            const mm = Math.round(C.numero(q.mm, NaN) * 10) / 10;
            if (!apagar && (!isFinite(mm) || mm < 0 || mm > 1000)) return L.resp(400, { ok: false, erro: "mm inválido." });
            await C.atualizar(codigo, (dados) => {
                const m = C.lerManual(dados);
                if (apagar) delete m[data]; else m[data] = mm;
                return { manual: JSON.stringify(C.podarDias(m)) };
            });
            return L.resp(200, { ok: true });
        }
        const d = await C.lerAparelho(codigo);
        if (!d) return L.resp(404, { ok: false, erro: "Pluviômetro não encontrado. Confira o código, ligue o aparelho, conecte ao Wi-Fi e espere uns 2 minutos." });
        const agora = Date.now();

        if (q.acao === "irrigar") return L.resp(200, C.statusIrrigacao(d.dados, agora));

        if (q.acao === "config") {
            if (event.httpMethod !== "POST") return L.resp(405, { ok: false, erro: "Use POST." });
            const limite = C.numero(q.limite, NaN);
            const dias = Math.min(7, Math.max(1, Math.round(Number(q.dias_considerados)) || 1));
            if (!isFinite(limite) || limite <= 0 || limite > 200) return L.resp(400, { ok: false, erro: "Limite entre 1 e 200 mm." });
            await C.atualizar(codigo, () => ({ limite: String(Math.round(limite * 10) / 10), diasConsiderados: dias }));
            return L.resp(200, { ok: true, limite: Math.round(limite * 10) / 10, dias_considerados: dias });
        }

        const dias = Math.min(400, Math.max(1, Number(q.dias) || 400));
        const desde = C.hojeBR(agora - dias * 86400000);
        const cfg = C.configDe(d.dados);
        return L.resp(200, {
            ok: true, hoje: C.hojeBR(agora), dias: C.lista(C.diasTodos(d.dados), desde),
            limite: cfg.limite, dias_considerados: cfg.dias,
            ultimo_contato: d.dados.ultimo ? new Date(Number(d.dados.ultimo)).toISOString() : "",
        });
    } catch (e) {
        console.error("chuva:", e);
        return L.resp(500, { ok: false, erro: "Erro no servidor. Tente novamente." });
    }
};
