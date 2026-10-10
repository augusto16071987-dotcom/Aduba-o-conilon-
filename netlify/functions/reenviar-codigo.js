// netlify/functions/reenviar-codigo.js
// { email } -> se existir cadastro, reenvia o código para o PRÓPRIO e-mail
// (nunca devolve o código ao app). Resposta é sempre a mesma.
const L = require("./lib/firestore");

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return L.resp(200, {});
    if (event.httpMethod !== "POST") return L.resp(405, { erro: "Use POST." });
    try {
        const b = L.parseBody(event);
        const canon = L.emailCanonico(b.email);
        if (!canon) return L.resp(400, { erro: "E-mail inválido." });
        const msg = { ok: true, aviso: "Se esse e-mail tiver cadastro, o código foi reenviado. Olhe também o spam." };
        const ex = await L.lerDoc(L.idEmail(canon));
        if (!ex) return L.resp(200, msg);
        const c = await L.lerDoc("c_" + ex.dados.codigo);
        if (!c) return L.resp(200, msg);
        const agora = Date.now();
        if (agora - Number(c.dados.ultimoEnvio || 0) < L.INTERVALO_REENVIO_MS)
            return L.resp(200, { ok: true, aviso: "O código foi enviado há pouco. Aguarde 2 minutos e tente de novo." });
        await L.gravar([{ id: "c_" + c.dados.codigo, dados: { ultimoEnvio: agora }, updateTime: c.updateTime }]).catch(() => {});
        await L.avisarPlanilha({ acao: "reenvio", nome: c.dados.nome, email: c.dados.email, codigo: c.dados.codigo,
            vencimento: L.fmtData(Number(c.dados.validoAte)) });
        return L.resp(200, msg);
    } catch (e) {
        console.error("reenviar-codigo:", e);
        return L.resp(500, { erro: "Erro no servidor. Tente novamente." });
    }
};
