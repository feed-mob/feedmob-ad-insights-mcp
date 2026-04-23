import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter, mcpAuthMetadataRouter } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/router.js';
import { requireBearerAuth } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/middleware/bearerAuth.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { connect, disconnect } from './mongo.js';
import {
  searchCompany,
  countCompanyRecords,
  getCompanySpend,
  getCompanyChannels,
  getSpendTrend,
  compareCompanies,
  getCreatives,
} from './tools.js';
import { SimpleOAuthProvider } from './auth.js';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── OAuth Provider ─────────────────────────────────────────────────
const oauthProvider = new SimpleOAuthProvider();
const issuerUrl = new URL(BASE_URL);
const resourceServerUrl = new URL('/mcp', issuerUrl);

// ── Tool Definitions ──────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_company',
    description:
      'Search for recent advertising records of a specific company (e.g. Chime, Uber, Binance) from the feedmob_db MongoDB. Returns the most recent N records including advertiser name, domain, brand, channel, publisher, spend, impressions, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        company_name: {
          type: 'string',
          description: 'The exact advertiser name (English). Use same casing as stored, e.g. "Uber", "Chime", "Binance".',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of records to return (default 5)',
        },
      },
      required: ['company_name'],
    },
  },
  {
    name: 'count_company_records',
    description: 'Get the total number of advertising records for a specific company.',
    inputSchema: {
      type: 'object',
      properties: {
        company_name: {
          type: 'string',
          description: 'The exact advertiser name.',
        },
      },
      required: ['company_name'],
    },
  },
  {
    name: 'get_company_spend',
    description:
      'Aggregate spend metrics (total spend, impressions, average CTR/CPM) for a company over the last N days.',
    inputSchema: {
      type: 'object',
      properties: {
        company_name: {
          type: 'string',
          description: 'The exact advertiser name.',
        },
        days: {
          type: 'number',
          description: 'Number of past days to aggregate (default 30)',
        },
      },
      required: ['company_name'],
    },
  },
  {
    name: 'get_company_channels',
    description:
      'Get advertising channel breakdown (e.g. Desktop Video, Mobile Display) with record count and spend per channel for a company.',
    inputSchema: {
      type: 'object',
      properties: {
        company_name: {
          type: 'string',
          description: 'The exact advertiser name.',
        },
      },
      required: ['company_name'],
    },
  },
  {
    name: 'get_spend_trend',
    description: 'Get daily spend trend (spend per day) for a company over the last N days.',
    inputSchema: {
      type: 'object',
      properties: {
        company_name: {
          type: 'string',
          description: 'The exact advertiser name.',
        },
        days: {
          type: 'number',
          description: 'Number of past days to aggregate (default 30)',
        },
      },
      required: ['company_name'],
    },
  },
  {
    name: 'compare_companies',
    description:
      'Compare advertising spend, impressions, CTR and CPM across multiple companies over the last N days.',
    inputSchema: {
      type: 'object',
      properties: {
        company_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of advertiser names to compare, e.g. ["Uber", "Chime", "Binance"].',
        },
        days: {
          type: 'number',
          description: 'Number of past days to aggregate (default 30)',
        },
      },
      required: ['company_names'],
    },
  },
  {
    name: 'get_creatives',
    description:
      'Get recent advertising creative details (campaign, creative URL, landing page, size, mime type) for a company.',
    inputSchema: {
      type: 'object',
      properties: {
        company_name: {
          type: 'string',
          description: 'The exact advertiser name.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of creatives to return (default 5)',
        },
      },
      required: ['company_name'],
    },
  },
];

function createServer() {
  const server = new Server(
    { name: 'feedmob-analytics-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      switch (name) {
        case 'search_company':
          result = await searchCompany(args.company_name, args.limit || 5);
          break;
        case 'count_company_records':
          result = await countCompanyRecords(args.company_name);
          break;
        case 'get_company_spend':
          result = await getCompanySpend(args.company_name, args.days || 30);
          break;
        case 'get_company_channels':
          result = await getCompanyChannels(args.company_name);
          break;
        case 'get_spend_trend':
          result = await getSpendTrend(args.company_name, args.days || 30);
          break;
        case 'compare_companies':
          result = await compareCompanies(args.company_names, args.days || 30);
          break;
        case 'get_creatives':
          result = await getCreatives(args.company_name, args.limit || 5);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// ── Express App ────────────────────────────────────────────────────
const app = express();
// Disable trust proxy (we'll disable express-rate-limit validation instead)

// JSON body parser for non-MCP routes (MCP routes need raw body)
app.use((req, res, next) => {
  if (req.path === '/mcp') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        req.body = data ? JSON.parse(data) : undefined;
      } catch {
        req.body = undefined;
      }
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});

// URL-encoded body parser for OAuth forms
app.use(express.urlencoded({ extended: false }));

// ── OAuth 2.1 Endpoints ────────────────────────────────────────────

// OAuth metadata (must be mounted at root)
app.use(
  mcpAuthMetadataRouter({
    oauthMetadata: {
      issuer: issuerUrl.href,
      authorization_endpoint: new URL('/authorize', issuerUrl).href,
      token_endpoint: new URL('/token', issuerUrl).href,
      registration_endpoint: new URL('/register', issuerUrl).href,
      revocation_endpoint: new URL('/revoke', issuerUrl).href,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    },
    resourceServerUrl,
    resourceName: 'FeedMob MCP Analytics API',
    scopesSupported: ['mcp:read', 'mcp:write'],
  })
);

// OAuth authorization server (must be mounted at root)
app.use(
  mcpAuthRouter({
    issuerUrl,
    baseUrl: issuerUrl,
    resourceServerUrl,
    resourceName: 'FeedMob MCP Analytics API',
    scopesSupported: ['mcp:read', 'mcp:write'],
    provider: oauthProvider,
    tokenOptions: { rateLimit: false },
    clientRegistrationOptions: { rateLimit: false },
    authorizationOptions: { rateLimit: false },
  })
);

// Custom approval form handler
app.post('/auth/approve', async (req, res) => {
  await oauthProvider.handleApprove(req, res);
});

// ── Bearer Auth Middleware ───────────────────────────────────────
const bearerAuth = requireBearerAuth({
  verifier: oauthProvider,
  requiredScopes: [],
});

// ── MCP Endpoints ──────────────────────────────────────────────────

const sessions = new Map();

function isInitializeRequest(body) {
  if (!body) return false;
  if (Array.isArray(body)) {
    return body.some((msg) => msg && msg.method === 'initialize');
  }
  return body.method === 'initialize';
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'feedmob-analytics-mcp', oauth: true });
});

// Streamable HTTP MCP (protected by Bearer auth)
app.all('/mcp', bearerAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (isInitializeRequest(req.body)) {
    let capturedSessionId = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        capturedSessionId = sid;
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
      },
    });

    const server = createServer();
    await server.connect(transport);

    transport.onclose = () => {
      if (capturedSessionId) sessions.delete(capturedSessionId);
    };

    await transport.handleRequest(req, res, req.body);

    if (capturedSessionId) {
      sessions.set(capturedSessionId, { transport, server });
    }
  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: Server not initialized' },
      id: null,
    });
  }
});

// Legacy SSE (also protected)
app.get('/mcp/sse', bearerAuth, async (_req, res) => {
  const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
  const legacyServer = createServer();
  const legacyTransport = new SSEServerTransport('/mcp/messages', res);

  legacyTransport.onclose = () => {};
  await legacyServer.connect(legacyTransport);
});

app.post('/mcp/messages', bearerAuth, async (req, res) => {
  res.status(404).json({ error: 'Legacy SSE session not found. Please use /mcp endpoint.' });
});

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  await connect();
  console.error('Connected to MongoDB');

  app.listen(PORT, '0.0.0.0', () => {
    console.error(`MCP Server running on ${BASE_URL}`);
    console.error(`OAuth endpoints:`);
    console.error(`  Metadata:    ${BASE_URL}/.well-known/oauth-authorization-server`);
    console.error(`  Authorize:   ${BASE_URL}/authorize`);
    console.error(`  Token:       ${BASE_URL}/token`);
    console.error(`  Register:    ${BASE_URL}/register`);
    console.error(`  MCP:         ${BASE_URL}/mcp`);
  });

  process.on('SIGINT', async () => {
    for (const { transport } of sessions.values()) {
      await transport.close();
    }
    sessions.clear();
    disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  disconnect();
  process.exit(1);
});
