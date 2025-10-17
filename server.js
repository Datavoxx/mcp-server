// server.js
import express from "express";
import morgan from "morgan";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
// Ex: ALLOWED_ORIGINS="https://chat.openai.com,https://builder.openai.com"

const REQUIRE_BEARER = process.env.REQUIRE_BEARER === "false" ? false : true;
const VALID_TOKENS = (process.env.MCP_TOKENS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
// Ex: MCP_TOKENS="abc123,def456"

const N8N_CREATE_LEAD_URL = process.env.N8N_CREATE_LEAD_URL;

// --- Middlewares ---
app.use(express.json({ type: "*/*", limit: "1mb" })); // accept any content-type; we'll validate later
app.use(morgan("combined"));

// Strict but usable CORS. We validate Origin ourselves too.
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // allow non-browser clients (curl/Postman)
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed`));
    },
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version"],
    credentials: false,
  })
);

// --- Helpers ---
const PROTOCOL_VERSION = "2025-06-18"; // be liberal in what you accept, strict in what you send

function okJson(res, body) {
  res.set("Content-Type", "application/json; charset=utf-8");
  return res.status(200).send(JSON.stringify(body));
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

function requireAuth(req, res) {
  if (!REQUIRE_BEARER) return true;
  const hdr = req.get("Authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token || (VALID_TOKENS.length && !VALID_TOKENS.includes(token))) {
    res.set("WWW-Authenticate", 'Bearer realm="mcp", error="invalid_token"');
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}

function validateOrigin(req, res) {
  const origin = req.get("Origin");
  if (!origin) return true; // non-browser
  if (ALLOWED_ORIGINS.length === 0) return true;
  if (!ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).send("Forbidden origin");
    return false;
  }
  return true;
}

// --- MCP tools in-memory ---
const tools = [
  {
    name: "hello_world",
    title: "Hello World",
    description: "Return a friendly greeting.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Your name" },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "call_n8n",
    title: "Call n8n Webhook",
    description:
      "För n8n-leadskapande. Skickar payload till n8n webhook och returnerar n8n-svar.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", format: "email", description: "Lead email" },
        name: { type: "string", description: "Lead name" },
        meta: {
          type: "object",
          description: "Valfri metadata",
          additionalProperties: true,
        },
      },
      required: ["email"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        n8nResponse: { type: "object", additionalProperties: true },
      },
      required: ["status"],
      additionalProperties: true,
    },
  },
];

// --- MCP endpoint (Streamable HTTP minimal: JSON only) ---
app.post("/mcp", async (req, res) => {
  try {
    if (!validateOrigin(req, res)) return;
    if (!requireAuth(req, res)) return;

    // Optional: accept and log MCP-Protocol-Version without rejecting
    const mcpVersion = req.get("MCP-Protocol-Version");
    if (mcpVersion) {
      console.log(`[mcp] MCP-Protocol-Version received: ${mcpVersion}`);
    }

    const msg = req.body;
    console.log("[mcp] ->", JSON.stringify(msg));

    if (!msg || msg.jsonrpc !== "2.0" || !msg.method) {
      return okJson(res, jsonRpcError(null, -32600, "Invalid Request"));
    }

    const { id, method, params } = msg;

    // --- initialize ---
    if (method === "initialize") {
      const result = {
        protocolVersion: PROTOCOL_VERSION, // negotiate to our version
        capabilities: {
          logging: {},
          tools: { listChanged: true },
          resources: { listChanged: false, subscribe: false },
          prompts: { listChanged: false },
        },
        serverInfo: {
          name: "your-mcp-server",
          title: "Your MCP Server (Express)",
          version: "1.0.0",
        },
        instructions:
          "MCP server for Agent Builder. Tools: hello_world, call_n8n. Return structuredContent per outputSchema.",
      };
      const resp = { jsonrpc: "2.0", id, result };
      console.log("[mcp] <-", JSON.stringify(resp));
      return okJson(res, resp);
    }

    // --- tools/list ---
    if (method === "tools/list") {
      const result = {
        tools,
        nextCursor: null,
      };
      const resp = { jsonrpc: "2.0", id, result };
      console.log("[mcp] <-", JSON.stringify(resp));
      return okJson(res, resp);
    }

    // --- tools/call ---
    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      if (!name) {
        return okJson(res, jsonRpcError(id, -32602, "Missing tool name"));
      }

      if (name === "hello_world") {
        const message = `Hej${args?.name ? " " + args.name : ""}! 👋`;
        const result = {
          content: [{ type: "text", text: JSON.stringify({ message }) }],
          structuredContent: { message },
          isError: false,
        };
        const resp = { jsonrpc: "2.0", id, result };
        console.log("[mcp] <-", JSON.stringify(resp));
        return okJson(res, resp);
      }

      if (name === "call_n8n") {
        if (!N8N_CREATE_LEAD_URL) {
          const result = {
            content: [{ type: "text", text: "N8N_CREATE_LEAD_URL is not configured" }],
            isError: true,
          };
          const resp = { jsonrpc: "2.0", id, result };
          console.log("[mcp] <-", JSON.stringify(resp));
          return okJson(res, resp);
        }

        // Forward Bearer token to n8n if present (optional, controlled)
        const authHeader = req.get("Authorization");

        const n8nRes = await fetch(N8N_CREATE_LEAD_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
          body: JSON.stringify(args || {}),
        });

        const text = await n8nRes.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (_) {
          parsed = { raw: text };
        }

        const result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: `n8n ${n8nRes.status}`,
                n8nResponse: parsed,
              }),
            },
          ],
          structuredContent: {
            status: `n8n ${n8nRes.status}`,
            n8nResponse: parsed,
          },
          isError: n8nRes.status >= 400,
        };
        const resp = { jsonrpc: "2.0", id, result };
        console.log("[mcp] <-", JSON.stringify(resp));
        return okJson(res, resp);
      }

      return okJson(res, jsonRpcError(id, -32602, `Unknown tool: ${name}`));
    }

    // Optional: ping/cancel/logging etc. (no-ops for now)
    if (method === "ping") {
      const resp = { jsonrpc: "2.0", id, result: { ok: true } };
      console.log("[mcp] <-", JSON.stringify(resp));
      return okJson(res, resp);
    }

    return okJson(res, jsonRpcError(id, -32601, `Method not found: ${method}`));
  } catch (err) {
    console.error("Unhandled /mcp error:", err);
    return okJson(res, jsonRpcError(null, -32603, "Internal error"));
  }
});

// (Valfritt) enkel manifest för discovery
app.get("/.well-known/mcp/manifest.json", (req, res) => {
  res.set("Content-Type", "application/json; charset=utf-8");
  res.send(
    JSON.stringify({
      name: "your-mcp-server",
      description: "MCP server exposing hello_world and call_n8n.",
      protocol: "jsonrpc-2.0",
      transport: "streamable-http",
      endpoint: `${process.env.PUBLIC_URL || ""}/mcp`,
      protocolVersion: PROTOCOL_VERSION,
      auth: { type: REQUIRE_BEARER ? "bearer" : "none" },
    })
  );
});

// health
app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`MCP server listening on :${PORT}`);
});
