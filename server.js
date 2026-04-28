const path = require("path");
require("dotenv").config({ override: true, path: path.resolve(__dirname, ".env.runtime") });
const express = require("express");

const app = express();
const AAD_TOKEN_SKEW_MS = 90 * 1000;
const EMBED_URL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let aadTokenCache = {
    token: "",
    expiresAt: 0,
};

let embedUrlCache = {
    key: "",
    url: "",
    expiresAt: 0,
};

// CORS middleware
app.use((req, res, next) => {
    const origin = req.headers.origin || req.headers.referer || "";
    res.header("Access-Control-Allow-Origin", origin || "*");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");

    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }

    next();
});

function getEnv(name) {
    const raw = process.env[name];
    if (!raw) {
        return "";
    }

    const trimmed = String(raw).trim();

    // Remove aspas acidentais no .env: VAR="valor"
    const unquoted = trimmed.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    return unquoted.trim();
}

const port = Number(getEnv("PORT") || 3000);

function maskValue(value) {
    if (!value) {
        return "(vazio)";
    }

    if (value.length <= 8) {
        return value;
    }

    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function requireEnv(name, value) {
    if (!value) {
        throw new Error(`Variavel obrigatoria ausente: ${name}`);
    }
}

async function getAadAccessToken() {
    if (aadTokenCache.token && aadTokenCache.expiresAt > Date.now()) {
        return aadTokenCache.token;
    }

    const PBI_TENANT_ID = getEnv("PBI_TENANT_ID");
    const PBI_CLIENT_ID = getEnv("PBI_CLIENT_ID");
    const PBI_CLIENT_SECRET = getEnv("PBI_CLIENT_SECRET");

    requireEnv("PBI_TENANT_ID", PBI_TENANT_ID);
    requireEnv("PBI_CLIENT_ID", PBI_CLIENT_ID);
    requireEnv("PBI_CLIENT_SECRET", PBI_CLIENT_SECRET);

    const tokenUrl = `https://login.microsoftonline.com/${PBI_TENANT_ID}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: PBI_CLIENT_ID,
        client_secret: PBI_CLIENT_SECRET,
        scope: "https://analysis.windows.net/powerbi/api/.default",
    });

    const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });

    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Falha ao obter token AAD (HTTP ${response.status}): ${details}`);
    }

    const data = await response.json();
    if (!data || !data.access_token) {
        throw new Error("Resposta invalida ao obter token AAD");
    }

    const now = Date.now();
    const expiresInMs = Math.max(60 * 1000, Number(data.expires_in || 3600) * 1000);
    aadTokenCache = {
        token: data.access_token,
        expiresAt: now + expiresInMs - AAD_TOKEN_SKEW_MS,
    };

    return aadTokenCache.token;
}

async function getReportEmbedUrl(aadToken, workspaceId, reportId) {
    const cacheKey = `${workspaceId}:${reportId}`;
    if (embedUrlCache.key === cacheKey && embedUrlCache.url && embedUrlCache.expiresAt > Date.now()) {
        return embedUrlCache.url;
    }

    const reportUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/reports/${reportId}`;
    const response = await fetch(reportUrl, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${aadToken}`,
        },
    });

    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Falha ao consultar report (HTTP ${response.status}): ${details}`);
    }

    const data = await response.json();
    if (!data || !data.embedUrl) {
        throw new Error("Resposta invalida ao consultar embedUrl do report");
    }

    embedUrlCache = {
        key: cacheKey,
        url: data.embedUrl,
        expiresAt: Date.now() + EMBED_URL_CACHE_TTL_MS,
    };

    return data.embedUrl;
}

async function generateEmbedToken(aadToken, workspaceId, reportId) {
    const generateUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/reports/${reportId}/GenerateToken`;
    const response = await fetch(generateUrl, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${aadToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            accessLevel: "View",
            allowSaveAs: false,
        }),
    });

    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Falha ao gerar embed token (HTTP ${response.status}): ${details}`);
    }

    const data = await response.json();
    if (!data || !data.token) {
        throw new Error("Resposta invalida ao gerar embed token");
    }

    return {
        token: data.token,
        expiration: data.expiration,
    };
}

async function powerBiApiRequest(aadToken, method, relativePath, body) {
    const url = `https://api.powerbi.com/v1.0/myorg${relativePath}`;
    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${aadToken}`,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    let responseBody = "";
    try {
        responseBody = await response.text();
    } catch (_error) {
        responseBody = "(sem corpo de resposta)";
    }

    return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url,
        body: responseBody,
    };
}

app.get("/api/powerbi/embed-token", async (req, res) => {
    try {
        const PBI_WORKSPACE_ID = getEnv("PBI_WORKSPACE_ID");
        const PBI_REPORT_ID = getEnv("PBI_REPORT_ID");
        const reportKey = req.query.reportKey;

        console.log(`[EMBED-TOKEN] reportKey: ${reportKey}, workspace: ${maskValue(PBI_WORKSPACE_ID)}, report: ${maskValue(PBI_REPORT_ID)}`);

        if (!reportKey) {
            return res.status(400).json({ message: "Parametro reportKey e obrigatorio" });
        }

        requireEnv("PBI_WORKSPACE_ID", PBI_WORKSPACE_ID);
        requireEnv("PBI_REPORT_ID", PBI_REPORT_ID);

        const aadToken = await getAadAccessToken();
        const [embedUrl, embedToken] = await Promise.all([
            getReportEmbedUrl(aadToken, PBI_WORKSPACE_ID, PBI_REPORT_ID),
            generateEmbedToken(aadToken, PBI_WORKSPACE_ID, PBI_REPORT_ID),
        ]);

        console.log(`[EMBED-TOKEN] ✓ Token gerado com sucesso, expira em: ${embedToken.expiration}`);

        return res.json({
            reportId: PBI_REPORT_ID,
            embedUrl,
            accessToken: embedToken.token,
            expiresAt: embedToken.expiration,
            reportKey,
        });
    } catch (error) {
        console.error("[EMBED-TOKEN] ✗ Erro:", error.message);

        var details = error.message;
        if (details && details.includes("AADSTS7000215")) {
            details = "PBI_CLIENT_SECRET invalido. Use o Secret Value (nao o Secret ID) do App Registration e gere um novo secret se necessario.";
        } else if (details && details.includes("PowerBINotAuthorizedException")) {
            details = "O aplicativo autenticou no Azure, mas nao tem permissao no Power BI para gerar o embed token. Habilite service principal no tenant do Power BI e adicione o app novo como membro ou admin do workspace do relatorio.";
        }

        return res.status(500).json({
            message: "Nao foi possivel gerar o token de embed",
            details,
        });
    }
});

app.get("/api/powerbi/debug", async (req, res) => {
    const PBI_WORKSPACE_ID = getEnv("PBI_WORKSPACE_ID");
    const PBI_REPORT_ID = getEnv("PBI_REPORT_ID");

    const result = {
        ok: false,
        env: {
            workspaceId: PBI_WORKSPACE_ID,
            reportId: PBI_REPORT_ID,
            clientId: maskValue(getEnv("PBI_CLIENT_ID")),
        },
        steps: [],
        timestamp: new Date().toISOString(),
    };

    function pushStep(name, ok, details) {
        result.steps.push({ name, ok, details });
    }

    try {
        requireEnv("PBI_WORKSPACE_ID", PBI_WORKSPACE_ID);
        requireEnv("PBI_REPORT_ID", PBI_REPORT_ID);

        const aadToken = await getAadAccessToken();
        pushStep("aadToken", true, "Token AAD obtido com sucesso");

        const workspaceCheck = await powerBiApiRequest(aadToken, "GET", `/groups/${PBI_WORKSPACE_ID}`);
        if (!workspaceCheck.ok) {
            pushStep("workspaceAccess", false, {
                status: workspaceCheck.status,
                body: workspaceCheck.body,
            });
            return res.status(500).json(result);
        }
        pushStep("workspaceAccess", true, `Workspace acessivel (HTTP ${workspaceCheck.status})`);

        const reportsListCheck = await powerBiApiRequest(aadToken, "GET", `/groups/${PBI_WORKSPACE_ID}/reports`);
        if (!reportsListCheck.ok) {
            pushStep("reportsList", false, {
                status: reportsListCheck.status,
                body: reportsListCheck.body,
            });
            return res.status(500).json(result);
        }

        let reportFoundInList = false;
        try {
            const parsed = JSON.parse(reportsListCheck.body || "{}");
            const reports = Array.isArray(parsed.value) ? parsed.value : [];
            reportFoundInList = reports.some((item) => String(item.id || "").toLowerCase() === PBI_REPORT_ID.toLowerCase());
            pushStep("reportsList", true, {
                status: reportsListCheck.status,
                totalReports: reports.length,
                reportFoundInWorkspace: reportFoundInList,
            });
        } catch (_parseError) {
            pushStep("reportsList", true, {
                status: reportsListCheck.status,
                warning: "Resposta de lista de reports nao foi parseada como JSON",
            });
        }

        const reportCheck = await powerBiApiRequest(aadToken, "GET", `/groups/${PBI_WORKSPACE_ID}/reports/${PBI_REPORT_ID}`);
        if (!reportCheck.ok) {
            pushStep("reportAccess", false, {
                status: reportCheck.status,
                body: reportCheck.body,
            });
            return res.status(500).json(result);
        }
        pushStep("reportAccess", true, `Report acessivel (HTTP ${reportCheck.status})`);

        const generateTokenCheck = await powerBiApiRequest(
            aadToken,
            "POST",
            `/groups/${PBI_WORKSPACE_ID}/reports/${PBI_REPORT_ID}/GenerateToken`,
            {
                accessLevel: "View",
                allowSaveAs: false,
            }
        );

        if (!generateTokenCheck.ok) {
            pushStep("generateToken", false, {
                status: generateTokenCheck.status,
                body: generateTokenCheck.body,
            });
            return res.status(500).json(result);
        }

        pushStep("generateToken", true, `GenerateToken concluido (HTTP ${generateTokenCheck.status})`);
        result.ok = true;
        return res.json(result);
    } catch (error) {
        pushStep("unexpectedError", false, error.message);
        return res.status(500).json(result);
    }
});

app.get("/health", (_req, res) => {
    const health = {
        status: "ok",
        port: port,
        envVars: {
            PBI_TENANT_ID: maskValue(getEnv("PBI_TENANT_ID")),
            PBI_CLIENT_ID: maskValue(getEnv("PBI_CLIENT_ID")),
            PBI_WORKSPACE_ID: maskValue(getEnv("PBI_WORKSPACE_ID")),
            PBI_REPORT_ID: maskValue(getEnv("PBI_REPORT_ID")),
        },
        timestamp: new Date().toISOString(),
    };
    res.json(health);
});

app.use(express.static(path.resolve(__dirname)));

app.get("*", (_req, res) => {
    res.sendFile(path.resolve(__dirname, "ExtratosAcess.html"));
});

app.listen(port, () => {
    console.log(`Portal executando em http://localhost:${port}`);
    console.log(`Power BI app carregado: ${maskValue(getEnv("PBI_CLIENT_ID"))}`);
});
