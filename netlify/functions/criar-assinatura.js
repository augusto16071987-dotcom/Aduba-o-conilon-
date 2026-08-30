// netlify/functions/criar-assinatura.js
//
// Recebe { clienteId, nome, email } do app, cria uma assinatura (preapproval)
// vinculada ao plano do NutriCafé no Mercado Pago (com os 30 dias grátis já
// configurados no próprio plano) e devolve o link de checkout (init_point)
// pro app redirecionar o navegador.
//
// Precisa da variável de ambiente MP_ACCESS_TOKEN configurada no Netlify
// (Project configuration > Environment variables). NUNCA coloque o token
// direto no código.

const MP_PLAN_ID = "aa2f72dffb8b4450aafd948385c14c21";

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
