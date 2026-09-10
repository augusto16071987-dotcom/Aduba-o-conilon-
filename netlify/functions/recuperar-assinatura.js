// netlify/functions/recuperar-assinatura.js
//
// Uso do CLIENTE (não é a função de suporte). Quando alguém troca de
// celular, limpa os dados do navegador ou reinstala o app, ele ganha um
// clienteId novo — e perde o vínculo com a assinatura que já pagou.
// Essa função resolve isso: recebe { email, clienteId (do aparelho atual) },
// procura uma assinatura autorizada com esse e-mail, e se achar, "clona"
// esse status pro clienteId atual — sem precisar de senha nem de suporte.
//
// Não expõe nada sensível: só devolve nome/validade pro próprio dono do
// e-mail que ele mesmo digitou.

const FIREBASE_PROJECT_ID = "backup-bb0d9";
const FIRESTORE_COLECAO = "nutricafe_dados";

function baseUrl() {
    return "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
        "/databases/(default)/documents/" + FIRESTORE_COLECAO;
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

function normalizar(txt) {
    return (txt || "").toLowerCase().trim();
}

async function listarRegistrosDeAssinatura() {
    const registros = [];
    let pageToken = null;
    do {
        const url = baseUrl() + "?pageSize=300" + (pageToken ? "&pageToken=" + pageToken : "");
        const res = await fetch(url);
        const json = await res.json();
        for (const doc of json.documents || []) {
            const nomeDoc = doc.name.split("/").pop();
            if (nomeDoc.indexOf("assinatura--") !== 0) continue;
            const f = doc.fields || {};
            registros.push({
                docId: nomeDoc,
                nome: f.nome ? f.nome.stringValue : "",
                email: f.email ? f.email.stringValue : "",
                status: f.status ? f.status.stringValue : "",
                preapprovalId: f.preapprovalId ? f.preapprovalId.stringValue : "",
                validoAte: f.validoAte ? f.validoAte.stringValue : null,
                proximaCobranca: f.proximaCobranca ? f.proximaCobranca.stringValue : null,
                liberadoManualmente: f.liberadoManualmente ? !!f.liberadoManualmente.booleanValue : false,
                atualizadoEm: f.atualizadoEm ? f.atualizadoEm.stringValue : "",
            });
        }
        pageToken = json.nextPageToken || null;
    } while (pageToken);
    return registros;
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
    const { email, clienteId } = corpo;
    if (!email || !email.trim()) {
        return { statusCode: 400, body: JSON.stringify({ erro: "Digite o e-mail que você usou pra assinar." }) };
    }
    if (!clienteId) {
        return { statusCode: 400, body: JSON.stringify({ erro: "Faltou identificar o aparelho." }) };
    }

    try {
        const registros = await listarRegistrosDeAssinatura();
        const buscaEmail = normalizar(email);
        const autorizados = registros
            .filter((r) => normalizar(r.email) === buscaEmail && r.status === "authorized")
            .sort((a, b) => (b.atualizadoEm || "").localeCompare(a.atualizadoEm || ""));

        if (autorizados.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ erro: "Não encontramos nenhuma assinatura ativa com esse e-mail. Confira se digitou certo, ou fale com o suporte." }),
            };
        }

        const encontrado = autorizados[0];
        const docIdAtual = ("assinatura--" + clienteId).replace(/[^a-zA-Z0-9_-]/g, "_");
        const campos = {
            status: { stringValue: "authorized" },
            nome: { stringValue: encontrado.nome || "" },
            email: { stringValue: encontrado.email || "" },
            preapprovalId: { stringValue: encontrado.preapprovalId || "" },
            atualizadoEm: { stringValue: new Date().toISOString() },
        };
        let mask = "?updateMask.fieldPaths=status&updateMask.fieldPaths=nome&updateMask.fieldPaths=email" +
            "&updateMask.fieldPaths=preapprovalId&updateMask.fieldPaths=atualizadoEm";
        if (encontrado.validoAte) {
            campos.validoAte = { stringValue: encontrado.validoAte };
            mask += "&updateMask.fieldPaths=validoAte";
        }
        if (encontrado.proximaCobranca) {
            campos.proximaCobranca = { stringValue: encontrado.proximaCobranca };
            mask += "&updateMask.fieldPaths=proximaCobranca";
        }

        const token = await obterTokenAdmin();
        await fetch(baseUrl() + "/" + docIdAtual + mask, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
            body: JSON.stringify({ fields: campos }),
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                ok: true,
                nome: encontrado.nome,
                email: encontrado.email,
                preapprovalId: encontrado.preapprovalId,
                validoAte: encontrado.validoAte,
                proximaCobranca: encontrado.proximaCobranca,
                liberadoManualmente: encontrado.liberadoManualmente,
            }),
        };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ erro: "Erro interno ao recuperar.", detalhes: String(e) }) };
    }
};
