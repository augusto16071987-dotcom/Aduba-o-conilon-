// netlify/functions/cancelar-assinatura.js
//
// Uso do CLIENTE, direto pelo app (Configurações → Assinatura → Cancelar).
// Recebe { clienteId } (do próprio aparelho de quem está pedindo — não
// precisa de senha, porque só afeta a assinatura vinculada a esse mesmo
// clienteId), busca o registro dele, e:
//   - Se for uma assinatura de verdade (tem preapprovalId e não foi
//     liberada manualmente): cancela pra valer na Mercado Pago.
//   - Se foi liberada manualmente (sem cartão, sem cobrança recorrente):
//     não tem nada pra cancelar na Mercado Pago — só encerra o acesso
//     direto no nosso banco.

const FIREBASE_PROJECT_ID = "backup-bb0d9";
const FIRESTORE_COLECAO = "nutricafe_dados";

function firestoreDocUrl(docId) {
    return "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
        "/databases/(default)/documents/" + FIRESTORE_COLECAO + "/" + docId;
}

const crypto = require("crypto");
function base64url(input) {
    return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function obterTokenAdmin() {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const agora = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claim = {
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/datastore",
        aud: "https://oauth2.googleapis.com/token",
        exp: agora + 3600,
        iat: agora,
    };
    const semAssinar = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(claim));
    const assinador = crypto.createSign("RSA-SHA256");
    assinador.update(semAssinar);
    assinador.end();
    const assinatura = assinador.sign(sa.private_key).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const jwt = semAssinar + "." + assinatura;
    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + encodeURIComponent(jwt),
    });
    const dados = await res.json();
    if (!dados.access_token) throw new Error("Não consegui autenticar com o Firebase (admin).");
    return dados.access_token;
}

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: JSON.stringify({ erro: "Método não permitido" }) };
    }
    let corpo;
    try {
        corpo = JSON.parse(event.body || "{}");
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ erro: "Corpo da requisição inválido." }) };
    }
    const { clienteId } = corpo;
    if (!clienteId) {
        return { statusCode: 400, body: JSON.stringify({ erro: "Faltou identificar o aparelho." }) };
    }

    try {
        const docId = ("assinatura--" + clienteId).replace(/[^a-zA-Z0-9_-]/g, "_");
        const res = await fetch(firestoreDocUrl(docId));
        if (!res.ok) {
            return { statusCode: 404, body: JSON.stringify({ erro: "Não encontrei sua assinatura." }) };
        }
        const doc = await res.json();
        const f = doc.fields || {};
        const preapprovalId = f.preapprovalId ? f.preapprovalId.stringValue : "";
        const liberadoManualmente = f.liberadoManualmente ? !!f.liberadoManualmente.booleanValue : false;

        // Assinatura real (tem cartão/cobrança recorrente na Mercado Pago) —
        // cancela lá pra valer, senão a cobrança do mês que vem continuaria
        // acontecendo mesmo com o app achando que cancelou.
        if (preapprovalId && !liberadoManualmente) {
            const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
            if (!ACCESS_TOKEN) {
                return { statusCode: 500, body: JSON.stringify({ erro: "Configuração ausente no servidor." }) };
            }
            const respMP = await fetch("https://api.mercadopago.com/preapproval/" + preapprovalId, {
                method: "PUT",
                headers: { "Content-Type": "application/json", "Authorization": "Bearer " + ACCESS_TOKEN },
                body: JSON.stringify({ status: "cancelled" }),
            });
            if (!respMP.ok) {
                const err = await respMP.json().catch(() => ({}));
                return { statusCode: 502, body: JSON.stringify({ erro: "Não consegui cancelar na Mercado Pago agora.", detalhes: err }) };
            }
        }

        // Em qualquer um dos dois casos, marca cancelado no nosso banco
        // também — assim o app libera na hora, sem esperar o webhook.
        const token = await obterTokenAdmin();
        await fetch(firestoreDocUrl(docId) + "?updateMask.fieldPaths=status&updateMask.fieldPaths=atualizadoEm", {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
            body: JSON.stringify({ fields: {
                status: { stringValue: "cancelled" },
                atualizadoEm: { stringValue: new Date().toISOString() },
            } }),
        });

        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ erro: "Erro interno ao cancelar.", detalhes: String(e) }) };
    }
};
