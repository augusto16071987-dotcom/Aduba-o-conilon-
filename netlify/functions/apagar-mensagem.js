// netlify/functions/apagar-mensagem.js
//
// Uso interno (chamado pelo painel de suporte, na moderação da comunidade).
// Recebe { senha, id } e apaga essa mensagem do chat. A senha é a MESMA
// senha do painel de suporte (SUPORTE_SENHA lá no index.html). Se trocar
// uma, troque a outra também.

const SENHA_ADMIN = "cafe-suporte-2026";

const FIREBASE_PROJECT_ID = "backup-bb0d9";
const COMUNIDADE_COLECAO = "nutricafe_comunidade";

function docUrl(id) {
    return "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
        "/databases/(default)/documents/" + COMUNIDADE_COLECAO + "/" + id;
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

    const { senha, id } = corpo;
    if (senha !== SENHA_ADMIN) {
        return { statusCode: 401, body: JSON.stringify({ erro: "Senha incorreta." }) };
    }
    if (!id) {
        return { statusCode: 400, body: JSON.stringify({ erro: "Falta o id da mensagem." }) };
    }

    try {
        const token = await obterTokenAdmin();
        await fetch(docUrl(id), {
            method: "DELETE",
            headers: { "Authorization": "Bearer " + token },
        });
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ erro: "Erro interno ao apagar.", detalhes: String(e) }) };
    }
};
