// netlify/functions/liberar-manual.js
//
// Uso interno (chamado pelo painel de suporte do próprio app). Recebe
// { senha, nome, meses }, procura na nuvem um cliente cujo nome bate com
// o texto digitado e marca a assinatura dele como "authorized" por esse
// número de meses — sem precisar de cartão nem do Mercado Pago. Serve
// pra casos de PIX combinado por fora, ou pra compensar algum problema
// de cobrança.
//
// A senha é a MESMA senha do painel de suporte (SUPORTE_SENHA lá no
// index.html). Se trocar uma, troque a outra também.

const SENHA_ADMIN = "cafe-suporte-2026";

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

// Gera um token de acesso "de servidor" a partir da chave de serviço do
// Firebase (variável de ambiente FIREBASE_SERVICE_ACCOUNT). Esse token
// ignora as regras de segurança do Firestore — só o servidor consegue
// gerar ele, porque só o servidor tem a chave privada.
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
    return (txt || "")
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
        .trim();
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
                clienteId: nomeDoc.replace(/^assinatura--/, ""),
                nome: f.nome ? f.nome.stringValue : "",
                email: f.email ? f.email.stringValue : "",
                status: f.status ? f.status.stringValue : "",
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

    const { senha, nome, meses } = corpo;
    if (senha !== SENHA_ADMIN) {
        return { statusCode: 401, body: JSON.stringify({ erro: "Senha incorreta." }) };
    }
    if (!nome || !nome.trim()) {
        return { statusCode: 400, body: JSON.stringify({ erro: "Digite o nome do cliente." }) };
    }
    const numMeses = Number(meses);
    if (!numMeses || numMeses <= 0) {
        return { statusCode: 400, body: JSON.stringify({ erro: "Número de meses inválido." }) };
    }

    try {
        const registros = await listarRegistrosDeAssinatura();
        const busca = normalizar(nome);
        const encontrados = registros.filter((r) => normalizar(r.nome).indexOf(busca) !== -1);

        if (encontrados.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ erro: "Nenhum cliente encontrado com esse nome. Ele precisa ter aberto a tela de assinatura no app pelo menos uma vez." }),
            };
        }
        if (encontrados.length > 1) {
            return {
                statusCode: 409,
                body: JSON.stringify({
                    erro: "Mais de um cliente encontrado. Seja mais específico.",
                    opcoes: encontrados.map((r) => ({ nome: r.nome, email: r.email })),
                }),
            };
        }

        const alvo = encontrados[0];
        const validoAte = new Date();
        validoAte.setMonth(validoAte.getMonth() + numMeses);

        const campos = {
            status: { stringValue: "authorized" },
            liberadoManualmente: { booleanValue: true },
            validoAte: { stringValue: validoAte.toISOString() },
            atualizadoEm: { stringValue: new Date().toISOString() },
        };
        const mask = "?updateMask.fieldPaths=status&updateMask.fieldPaths=liberadoManualmente" +
            "&updateMask.fieldPaths=validoAte&updateMask.fieldPaths=atualizadoEm";

        const token = await obterTokenAdmin();
        await fetch(baseUrl() + "/" + alvo.docId + mask, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
            body: JSON.stringify({ fields: campos }),
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                ok: true,
                nome: alvo.nome,
                email: alvo.email,
                validoAte: validoAte.toISOString(),
            }),
        };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ erro: "Erro interno ao liberar.", detalhes: String(e) }) };
    }
};
