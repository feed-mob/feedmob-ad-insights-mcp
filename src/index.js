import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
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

const PORT = process.env.PORT || 3000;
const MCP_API_KEY = process.env.MCP_API_KEY;

// Simple Bearer token auth middleware for /mcp endpoint
function requireApiKey(req, res, next) {
  if (!MCP_API_KEY) {
    return next();
  }
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized: Missing Authorization header' },
      id: null,
    });
  }
  const [type, token] = authHeader.split(' ');
  if (type?.toLowerCase() !== 'bearer' || token !== MCP_API_KEY) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized: Invalid token' },
      id: null,
    });
  }
  next();
}

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
    description:
      'Get the total number of advertising records for a specific company.',
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
    description:
      'Get daily spend trend (spend per day) for a company over the last N days.',
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

const app = express();

// Only parse JSON for non-MCP routes; MCP routes need raw body handling
app.use((req, res, next) => {
  if (req.path === '/mcp') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
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

// Session management for Streamable HTTP (stateful mode)
// Each session gets its own transport + server instance
const sessions = new Map();

function isInitializeRequest(body) {
  if (!body) return false;
  if (Array.isArray(body)) {
    return body.some(msg => msg && msg.method === 'initialize');
  }
  return body.method === 'initialize';
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'feedmob-analytics-mcp' });
});

// Streamable HTTP: single /mcp endpoint handles both GET and POST
app.all('/mcp', requireApiKey, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  // Route to existing session if session ID is provided and valid
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // No valid session ID - must be initialization or invalid
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
      if (capturedSessionId) {
        sessions.delete(capturedSessionId);
      }
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

// Keep legacy SSE endpoint for backward compatibility during transition
app.get('/mcp/sse', requireApiKey, async (_req, res) => {
  const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
  const legacyServer = createServer();
  const legacyTransport = new SSEServerTransport('/mcp/messages', res);

  legacyTransport.onclose = () => {};
  await legacyServer.connect(legacyTransport);
});

app.post('/mcp/messages', requireApiKey, async (req, res) => {
  // If reached here via legacy SSE path, return error
  res.status(404).json({ error: 'Legacy SSE session not found. Please use /mcp endpoint.' });
});

async function main() {
  await connect();
  console.error('Connected to MongoDB');

  app.listen(PORT, '0.0.0.0', () => {
    console.error(`MCP Server running on http://0.0.0.0:${PORT}`);
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
