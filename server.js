import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Enkel logger (syns i Render logs) ----------
app.use((req, _res, next) => {
  const auth = req.header("authorization") ? "✅" : "❌";
  console.log(`[IN] ${req.method} ${req.path} (auth=${auth})`);
  next();
});

// ---------- Health ----------
app.get("/", (_req, res) => res.send("MCP up"));

// ---------- n8n-workflows (namn -> URL via env) ----------
const N8N_MAP = {
  "create-lead": process.env.N8N_CREATE_LEAD_URL,
  "send-welcome-email": process.env.N8N_SEND_WELCOME_URL,
};

// Endast workflows som faktiskt har URL i env:
const AVAILABLE_WORKFLOWS = Object.entries(N8N_MAP)
  .filter(([, url]) => !!url)
  .map(([name]) => name);

// ---------- MCP MANIFEST (ska vara öppen) ----------
app.get("/mcp/manifest", (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).json({
    tools: [
      {
        name: "hello_world",
        description: "Returnerar en hälsning.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Ditt namn" },
          },
          required: ["name"],
        },
      },
      {
        name: "call_n8n",
        description:
          "Anropa ett n8n-workflow via namn. Skicka JSON-payload och få tillbaka n8n-svaret.",
        input_schema: {
          type: "object",
          properties: {
            flow: {
              type: "string",
              enum: AVAILABLE_WORKFLOWS,
              description: "Vilket n8n-workflow (t.ex. create-lead)",
            },
            data: {
              type: "object",
              description: "JSON-data som skickas till n8n",
            },
            headers: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Extra headers till n8n om auth krävs",
            },
          },
          required: ["flow", "data"],
        },
      },
    ],
  });
});

// ---------- Tools endpoint list (också öppen) ----------
app.get("/mcp/tools", (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).json({
    tools: [
      { name: "hello_world" },
      { name: "call_n8n" },
    ],
  });
});

// ---------- Auth middleware (för allt annat) ----------
app.use((req, res, next) => {
  // Gör vissa vägar publika
  if (["/", "/mcp/manifest", "/mcp/tools"].includes(req.path)) return next();

  const auth = req.header("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const xkey = req.header("x-mcp-key");
  const token = bearer || xkey;

  if (process.env.MCP_KEY) {
    if (!token || token !== process.env.MCP_KEY) {
      console.warn(`[AUTH FAIL] path=${req.path}`);
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

// ---------- Hjälpare ----------
function getParams(req) {
  const raw = req.body?.params ?? req.body ?? {};
  const flow = raw.flow ?? raw.workflow;
  const data = raw.data ?? raw.payload ?? {};
  const headers = raw.headers ?? {};
  return { flow, data, headers, raw };
}

async function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ---------- TOOLS ----------

// 1) Hello World – snabb sanity check
app.post("/mcp/tools/hello_world", (req, res) => {
  const { name } = getParams(req);
  console.log("[hello_world]", name);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json({ ok: true, message: `Hej ${name}! MCP funkar 🎉` });
});

// 2) call_n8n – postar till rätt n8n-webhook
app.post("/mcp/tools/call_n8n", async (req, res) => {
  try {
    const { flow, data, headers } = getParams(req);
    console.log("[call_n8n] flow:", flow, "body:", JSON.stringify(data).slice(0, 200));

    if (!flow) {
      return res.status(400).json({ ok: false, error: "Missing 'flow'" });
    }

    const url = N8N_MAP[flow];

    if (!AVAILABLE_WORKFLOWS.includes(flow) || !url) {
      return res.status(400).json({
        ok: false,
        error: "Unknown or unavailable workflow",
        flow,
        available: AVAILABLE_WORKFLOWS,
      });
    }

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(data ?? {}),
    });

    const text = await r.text();
    const json = await tryParseJson(text);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: r.ok,
      status: r.status,
      n8n_url: url,
      request: { flow, data },
      response: json,
    });
  } catch (e) {
    console.error("[call_n8n] error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ MCP running on :${PORT}`));
