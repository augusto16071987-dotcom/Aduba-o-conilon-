// netlify/functions/mp-webhook.js
//
// O Mercado Pago chama essa URL sozinho toda vez que algo muda numa
// assinatura (nova, autorizada, pausada, cancelada, cobrança do mês).
// A função busca os dados de verdade na API do Mercado Pago (nunca confia
// só no que veio na notificação) e grava o status atual no Firestore, no
// mesmo banco de dados que o app já usa pra sincronizar.
//
// Configurar essa URL no painel do Mercado Pago em:
// Suas integrações > (aplicação NutriCafe) > Webhooks
//   URL: https://SEU-SITE.netlify.app/.netlify/functions/mp-webhook
//   Eventos: "Assinaturas" (subscription_preapproval)
//
// Precisa da variável de ambiente MP_ACCESS_TOKEN configurada no Netlify.

const FIREBASE_PROJECT_ID = "backup-bb0d9";
const FIRESTORE_COLECAO = "nutricafe_dados";

function firestoreDocUrl(docId) {
    return "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
        "/databases/(default)/documents/" + FIRESTORE_COLECAO + "/" + docId;
}

async function salvarStatusAssinatura(clienteId, preapproval) {
    const docId = ("assinatura--" + clienteId).replace(/[^a-zA-Z0-9_-]/g, "_");
    // O "reason" vem como "Assinatura NutriCafé — Nome Do Cliente" — extrai
    // só o nome pra manter o registro localizável por nome no painel de suporte.
    let nome = "";
    if (preapproval.reason && preapproval.reason.indexOf("—") !== -1) {
        nome = preapproval.reason.split("—").slice(1).join("—").trim();
    }
    const campos = {
        status: { stringValue: preapproval.status || "" },
        preapprovalId: { stringValue: preapproval.id || "" },
        email: { stringValue: preapproval.payer_email || "" },
        atualizadoEm: { stringValue: new Date().toISOString() },
    };
    let mask = "?updateMask.fieldPaths=status&updateMask.fieldPaths=preapprovalId" +
        "&updateMask.fieldPaths=email&updateMask.fieldPaths=atualizadoEm";
    if (nome) {
        campos.nome = { stringValue: nome };
        mask += "&updateMask.fieldPaths=nome";
    }
    await fetch(firestoreDocUrl(docId) + mask, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: campos }),
    });
}

exports.handler = async (event) => {
    const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

    // Sempre respondemos 200 pro Mercado Pago não ficar tentando de novo
    // em loop — qualquer problema aqui é só logado, nunca vira erro pra ele.
    const ok = { statusCode: 200, body: "ok" };
    if (!ACCESS_TOKEN) {
        console.error("MP_ACCESS_TOKEN não configurado");
        return ok;
    }

    try {
        let preapprovalId = null;

        // Formato novo (o mais comum): POST com corpo JSON
        if (event.body) {
            try {
                const corpo = JSON.parse(event.body);
                if (corpo && corpo.data && corpo.data.id &&
                    (corpo.type === "subscription_preapproval" || corpo.type === "preapproval")) {
                    preapprovalId = corpo.data.id;
                }
            } catch (e) {
                // corpo não era JSON — segue pra tentar pela query string
            }
        }

        // Formato antigo (IPN): vem como parâmetros na URL
        const params = event.queryStringParameters || {};
        if (!preapprovalId && params.id && (params.topic === "preapproval" || params.type === "preapproval")) {
            preapprovalId = params.id;
        }

        if (!preapprovalId) {
            // Notificação de outro tipo (ex: pagamento avulso da fatura mensal) —
            // não precisamos fazer nada, o status do preapproval já reflete tudo.
            return ok;
        }

        const resposta = await fetch("https://api.mercadopago.com/preapproval/" + preapprovalId, {
            headers: { "Authorization": "Bearer " + ACCESS_TOKEN },
        });
        const preapproval = await resposta.json();

        if (resposta.ok && preapproval.external_reference) {
            await salvarStatusAssinatura(preapproval.external_reference, preapproval);
        }
    } catch (e) {
        console.error("Erro no webhook do Mercado Pago:", e);
    }

    return ok;
};
