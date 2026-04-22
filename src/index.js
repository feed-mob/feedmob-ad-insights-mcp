import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { connect, disconnect } from './mongo.js';
import {
  searchCompany,
  countCompanyRecords,
  getCompanySpend,
  getCompanyChannels,
} from './tools.js';

const PORT = process.env.PORT || 3000;

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
app.use(express.json());
const transports = new Map();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'feedmob-analytics-mcp' });
});

app.get('/mcp/sse', async (_req, res) => {
  const server = createServer();
  const transport = new SSEServerTransport('/mcp/messages', res);
  transports.set(transport.sessionId, { server, transport });

  transport.onclose = () => {
    transports.delete(transport.sessionId);
  };

  await server.connect(transport);
});

app.post('/mcp/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const entry = transports.get(sessionId);

  if (!entry) {
    return res.status(404).json({ error: 'Session not found' });
  }

  await entry.transport.handlePostMessage(req, res, req.body);
});

async function main() {
  await connect();
  console.error('Connected to MongoDB');

  app.listen(PORT, '0.0.0.0', () => {
    console.error(`MCP Server running on http://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  disconnect();
  process.exit(1);
});