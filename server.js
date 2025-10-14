import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Health (valfritt men bra) ----------
app.get("/", (_req, res) => res.send("MCP up"));

// ---------- Auth: Bearer ELLER x-mcp-key ----------
app.use((req, res, next) => {
  // Tillåt både "Authorization: Bearer <token>" och "x-mcp-key: <token>"
  const auth = req.header("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const xkey = req.header("x-mcp-key");
  const token = bearer || xkey;

  if (process.env.MCP_KEY) {
    if (!token || token !== process.env.MCP_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

// ---------- n8n-workflows (namn -> URL via env) ----------
const N8N_MAP = {
  "create-lead": process.env.N8N_CREATE_LEAD_URL,
  "send-welcome-email": process.env.N8N_SEND_WELCOME_URL,
};

// Endast workflows som faktiskt har URL i env:
const AVAILABLE_WORKFLOWS = Object.entries(N8N_MAP)
  .filter(([, url]) => !!url)
  .map(([name]) => name);

// ---------- MCP MANIFEST ----------
app.get("/mcp/manifest", (_req, res) => {
  res.json({
    tools: [
      {
        name: "hello_world",
        description: "Returnerar en hälsning.",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      {
        name: "call_n8n",
        description:
          "Anropa ett n8n-workflow via namn. Skicka JSON-payload och få tillbaka n8n-svaret.",
        parameters: {
          type: "object",
          properties: {
            // visa bara workflows som finns konfigurerade
            workflow: { type: "string", enum: AVAILABLE_WORKFLOWS },
            payload: { type: "object" },
            headers: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Extra headers till n8n om du kräver auth",
            },
          },
          required: ["workflow"],
        },
      },
    ],
  });
});

// ---------- TOOLS ----------

// 1) Hello World – snabb sanity check
app.post("/mcp/tools/hello_world", (req, res) => {
  const { name } = req.body || {};
  return res.json({ ok: true, message: `Hej ${name}! MCP funkar 🎉` });
});

// 2) call_n8n – postar till rätt n8n-webhook
app.post("/mcp/tools/call_n8n", async (req, res) => {
  try {
    const { workflow, payload = {}, headers = {} } = req.body || {};
    const url = N8N_MAP[workflow];

    if (!AVAILABLE_WORKFLOWS.includes(workflow) || !url) {
      return res
        .status(400)
        .json({ ok: false, error: "Unknown or unavailable workflow" });
    }

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    return res.json({ ok: r.ok, status: r.status, data });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "Unknown error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MCP running on :${PORT}`));
