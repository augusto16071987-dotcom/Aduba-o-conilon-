// netlify/functions/criar-assinatura.js
//
// Recebe { clienteId, nome, email } do app, cria uma assinatura (preapproval)
// vinculada ao plano do NutriCafé no Mercado Pago (com os 30 dias grátis já
// configurados no próprio plano) e devolve o link de checkout (init_point)
// pro app redirecionar o navegador.
//
// Proteção contra cobrança em duplicidade: antes de criar, consulta o Mercado
// Pago pelo e-mail. Se já existe assinatura ATIVA desse e-mail, não cria outra
// (manda o cliente usar "Recuperar acesso"). Se já existe uma pendente criada
// por este mesmo aparelho, reaproveita o link em vez de gerar outra.
//
// Precisa da variável de ambiente MP_ACCESS_TOKEN configurada no Netlify
// (Project configuration > Environment variables). NUNCA coloque o token
// direto no código.

const MP_PLAN_ID = "aa2f72dffb8b4450aafd948385c14c21";

function normalizarEmail(e) {
    return String(e || "").trim().toLowerCase();
}

// Busca no Mercado Pago as assinaturas deste plano feitas com o e-mail
// informado. Filtra de novo aqui dentro (e-mail e plano) pra nunca depender
// só do filtro do Mercado Pago: se ele ignorasse algum parâmetro, a gente
// poderia bloquear a pessoa errada.
async function buscarAssinaturasDoEmail(accessToken, email) {
    const params = new URLSearchParams({ payer_email: email, preapproval_plan_id: MP_PLAN_ID, limit: "50" });
    const res = await fetch("https://api.mercadopago.com/preapproval/search?" + params.toString(), {
        headers: { "Authorization": "Bearer " + accessToken },
    });
    if (!res.ok) throw new Error("busca no Mercado Pago falhou: HTTP " + res.status);
    const json = await res.json();
    const alvo = normalizarEmail(email);
    return (json.results || []).filter((a) =>
        normalizarEmail(a.payer_email) === alvo &&
        (!a.preapproval_plan_id || a.preapproval_plan_id === MP_PLAN_ID));
}

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: JSON.stringify({ erro: "Método não permitido" }) };
    }

    const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!ACCESS_TOKEN) {
        return { statusCode: 500, body: JSON.stringify({ erro: "Servidor não configurado (falta MP_ACCESS_TOKEN)." }) };
    }

    let corpo;
    try {
        corpo = JSON.parse(event.body || "{}");
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ erro: "Corpo da requisição inválido." }) };
    }

    const { clienteId, nome, email } = corpo;
    if (!clienteId || !email) {
        return { statusCode: 400, body: JSON.stringify({ erro: "clienteId e email são obrigatórios." }) };
    }

    const siteUrl = "https://" + (event.headers.host || "nutricafe-conilon.netlify.app");

    // Evita cobrança em duplicidade (ver cabeçalho). Se a consulta falhar,
    // segue e cria normalmente: melhor não travar uma assinatura nova do que
    // bloquear um cliente por erro de rede.
    try {
        const existentes = await buscarAssinaturasDoEmail(ACCESS_TOKEN, email);
        if (existentes.some((a) => a.status === "authorized")) {
            return {
                statusCode: 409,
                body: JSON.stringify({
                    erro: "Já existe uma assinatura ativa com esse e-mail. Volte e toque em \"Já é assinante? Recuperar acesso\", usando o mesmo e-mail — sem pagar de novo.",
                    jaAssinante: true,
                }),
            };
        }
        const pendenteDesteAparelho = existentes.find((a) =>
            a.status === "pending" && a.external_reference === clienteId && a.init_point);
        if (pendenteDesteAparelho) {
            return {
                statusCode: 200,
                body: JSON.stringify({ initPoint: pendenteDesteAparelho.init_point, preapprovalId: pendenteDesteAparelho.id, reaproveitada: true }),
            };
        }
    } catch (e) {
        console.error("criar-assinatura: não consegui conferir assinaturas existentes —", String(e));
    }

    try {
        const resposta = await fetch("https://api.mercadopago.com/preapproval", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                preapproval_plan_id: MP_PLAN_ID,
                reason: "Assinatura NutriCafé" + (nome ? " — " + nome : ""),
                external_reference: clienteId,
                payer_email: email,
                back_url: siteUrl + "/?assinatura=voltou",
                status: "pending",
            }),
        });

        const dados = await resposta.json();

        if (!resposta.ok) {
            return {
                statusCode: resposta.status,
                body: JSON.stringify({ erro: dados.message || "O Mercado Pago recusou o pedido.", detalhes: dados }),
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ initPoint: dados.init_point, preapprovalId: dados.id }),
        };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ erro: "Erro interno ao falar com o Mercado Pago.", detalhes: String(e) }) };
    }
};
