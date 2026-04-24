import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

// ── In-Memory Stores ───────────────────────────────────────────────

class InMemoryClientsStore {
  constructor() {
    this._clients = new Map();
  }

  async registerClient(client) {
    const id = randomUUID();
    const full = {
      ...client,
      client_id: id,
      registration_access_token: randomUUID(),
      registration_client_uri: '',
    };
    this._clients.set(id, full);
    return full;
  }

  async getClient(clientId) {
    return this._clients.get(clientId) ?? null;
  }

  async updateClient(clientId, meta) {
    const existing = this._clients.get(clientId);
    if (!existing) return null;
    const updated = { ...existing, ...meta };
    this._clients.set(clientId, updated);
    return updated;
  }

  async deleteClient(clientId) {
    this._clients.delete(clientId);
  }
}

class InMemoryAuthStore {
  constructor() {
    this._codes = new Map();      // authorizationCode -> { clientId, codeChallenge, redirectUri, scopes, state, expiresAt }
    this._tokens = new Map();     // accessToken -> { clientId, scopes, expiresAt }
    this._refreshTokens = new Map(); // refreshToken -> { clientId, scopes, expiresAt }
  }

  saveCode(clientId, codeChallenge, redirectUri, scopes, state) {
    const code = randomUUID();
    console.error('[STORE] saveCode:', code.slice(0, 8), 'clientId:', clientId, 'challenge:', codeChallenge?.slice(0, 10), 'redirectUri:', redirectUri);
    this._codes.set(code, {
      clientId,
      codeChallenge,
      redirectUri,
      scopes,
      state,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
    });
    return code;
  }

  getCode(code) {
    const record = this._codes.get(code);
    console.error('[STORE] getCode:', code?.slice(0, 8), 'found:', !!record);
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      console.error('[STORE] getCode: expired, deleting');
      this._codes.delete(code);
      return null;
    }
    return record;
  }

  deleteCode(code) {
    this._codes.delete(code);
  }

  saveToken(clientId, scopes) {
    const token = randomUUID();
    const refreshToken = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    this._tokens.set(token, { clientId, scopes, expiresAt });
    this._refreshTokens.set(refreshToken, { clientId, scopes, expiresAt: expiresAt + 86400 * 7 });
    return { token, refreshToken, expiresAt };
  }

  getToken(token) {
    const record = this._tokens.get(token);
    if (!record) return null;
    if (Date.now() / 1000 > record.expiresAt) {
      this._tokens.delete(token);
      return null;
    }
    return record;
  }

  getRefreshToken(refreshToken) {
    const record = this._refreshTokens.get(refreshToken);
    if (!record) return null;
    if (Date.now() / 1000 > record.expiresAt) {
      this._refreshTokens.delete(refreshToken);
      return null;
    }
    return record;
  }

  revokeToken(token) {
    this._tokens.delete(token);
  }
}

// ── OAuth Provider ─────────────────────────────────────────────────

const API_KEY = process.env.MCP_API_KEY;

function getBaseUrl(req) {
  if (process.env.BASE_URL) return new URL(process.env.BASE_URL);
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${process.env.PORT || 3000}`;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return new URL(`${proto}://${host}`);
}

export class SimpleOAuthProvider {
  constructor() {
    this.clientsStore = new InMemoryClientsStore();
    this._store = new InMemoryAuthStore();
    this._pending = new Map(); // state -> { clientId, codeChallenge, redirectUri, scopes }
    // Tell the SDK to skip local PKCE validation and pass code_verifier to us
    this.skipLocalPkceValidation = true;
  }

  async authorize(client, params, res) {
    const { redirectUri, scopes, state, codeChallenge } = params;
    console.error('[AUTH] authorize called, client:', client?.client_id, 'redirectUri:', redirectUri, 'codeChallenge:', codeChallenge?.slice(0, 10), 'state:', state?.slice(0, 8));
    const stateKey = state || randomUUID();

    this._pending.set(stateKey, {
      clientId: client.client_id,
      codeChallenge,
      redirectUri,
      scopes: scopes || [],
      state: stateKey,
    });

    // Render a simple HTML form where the user enters the pre-shared key
    const formUrl = new URL('/auth/approve', getBaseUrl(res.req)).href;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FeedMob MCP Authorization</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 420px;
      width: 100%;
      text-align: center;
    }
    h1 { margin: 0 0 8px; font-size: 24px; color: #333; }
    p { color: #666; margin: 0 0 24px; font-size: 14px; }
    .logo {
      font-size: 48px;
      margin-bottom: 16px;
    }
    input[type="password"] {
      width: 100%;
      padding: 14px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 10px;
      font-size: 16px;
      box-sizing: border-box;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      width: 100%;
      padding: 14px;
      margin-top: 16px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
    .error {
      color: #e74c3c;
      font-size: 13px;
      margin-top: 12px;
      display: none;
    }
    .client-info {
      background: #f8f9fa;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 20px;
      font-size: 13px;
      color: #555;
    }
    .scope-tag {
      display: inline-block;
      background: #e8e0f0;
      color: #764ba2;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      margin: 2px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🔐</div>
    <h1>Authorize FeedMob MCP</h1>
    <p>Enter your API key to grant access to FeedMob advertising analytics.</p>
    <div class="client-info">
      <strong>Client:</strong> ${escapeHtml(client.client_name || 'Unknown Client')}<br>
      <strong>Scopes:</strong> ${(scopes || []).map(s => `<span class="scope-tag">${escapeHtml(s)}</span>`).join(' ') || '<span class="scope-tag">default</span>'}
    </div>
    <form method="POST" action="${escapeHtml(formUrl)}">
      <input type="hidden" name="state" value="${escapeHtml(stateKey)}">
      <input type="password" name="api_key" placeholder="Enter your API key" required autofocus>
      <button type="submit">Authorize</button>
    </form>
    <div class="error" id="err"></div>
  </div>
  <script>
    const url = new URL(window.location.href);
    if (url.searchParams.has('error')) {
      document.getElementById('err').style.display = 'block';
      document.getElementById('err').textContent = decodeURIComponent(url.searchParams.get('error_description') || url.searchParams.get('error'));
    }
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    console.error('[AUTH] challengeForAuthorizationCode called for client:', client?.client_id, 'code:', authorizationCode?.slice(0, 8));
    const record = this._store.getCode(authorizationCode);
    console.error('[AUTH] challengeForAuthorizationCode found record:', !!record, 'challenge:', record?.codeChallenge?.slice(0, 10));
    return record?.codeChallenge || '';
  }

  async exchangeAuthorizationCode(client, authorizationCode, codeVerifier, redirectUri, resource) {
    console.error('[AUTH] exchangeAuthorizationCode called for client:', client?.client_id, 'code:', authorizationCode?.slice(0, 8), 'verifier length:', codeVerifier?.length, 'redirectUri:', redirectUri);
    try {
      const record = this._store.getCode(authorizationCode);
      console.error('[AUTH] got code record:', !!record);
      if (!record) throw new Error('Invalid authorization code');
      console.error('[AUTH] client match:', record.clientId === client.client_id, 'record.clientId:', record.clientId, 'client.client_id:', client.client_id);
      if (record.clientId !== client.client_id) throw new Error('Client mismatch');
      if (redirectUri && record.redirectUri !== redirectUri) {
        console.error('[AUTH] redirectUri mismatch:', record.redirectUri, 'vs', redirectUri);
        throw new Error('Redirect URI mismatch');
      }

      // PKCE validation
      if (record.codeChallenge) {
        const verifier = codeVerifier || '';
        console.error('[AUTH] verifying PKCE, verifier length:', verifier.length, 'stored challenge prefix:', record.codeChallenge.slice(0, 10));
        const challenge = await pkceChallenge(verifier);
        console.error('[AUTH] computed challenge prefix:', challenge.slice(0, 10), 'match:', challenge === record.codeChallenge);
        if (challenge !== record.codeChallenge) throw new Error('PKCE verification failed');
      }

      this._store.deleteCode(authorizationCode);
      const { token, refreshToken, expiresAt } = this._store.saveToken(client.client_id, record.scopes);
      console.error('[AUTH] token issued, expiresAt:', expiresAt);
      return {
        access_token: token,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: expiresAt - Math.floor(Date.now() / 1000),
        scope: record.scopes.join(' '),
      };
    } catch (err) {
      console.error('[AUTH] exchangeAuthorizationCode ERROR:', err.message, err.stack);
      throw err;
    }
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const record = this._store.getRefreshToken(refreshToken);
    if (!record) throw new Error('Invalid refresh token');
    if (record.clientId !== client.client_id) throw new Error('Client mismatch');

    const { token, refreshToken: newRefresh, expiresAt } = this._store.saveToken(client.client_id, scopes || record.scopes);
    return {
      access_token: token,
      refresh_token: newRefresh,
      token_type: 'bearer',
      expires_in: expiresAt - Math.floor(Date.now() / 1000),
      scope: (scopes || record.scopes).join(' '),
    };
  }

  async verifyAccessToken(token) {
    // Accept API_KEY as a static bearer token for mcp-remote bridge mode
    if (API_KEY && token === API_KEY) {
      return {
        token,
        clientId: 'api-key',
        scopes: ['mcp:read', 'mcp:write'],
        expiresAt: Math.floor(Date.now() / 1000) + 86400 * 365,
      };
    }
    const record = this._store.getToken(token);
    if (!record) throw new Error('Invalid or expired token');
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
    };
  }

  async revokeToken(client, request) {
    if (request.token) this._store.revokeToken(request.token);
  }

  // ── Custom approve handler ───────────────────────────────────────

  async handleApprove(req, res) {
    const { state, api_key } = req.body || {};
    console.error('[AUTH] handleApprove called, state:', state?.slice(0, 8));
    const pending = this._pending.get(state);
    if (!pending) {
      console.error('[AUTH] handleApprove: pending not found');
      return res.status(400).json({ error: 'invalid_request', error_description: 'Authorization session expired or invalid' });
    }
    console.error('[AUTH] handleApprove: pending found, clientId:', pending.clientId, 'redirectUri:', pending.redirectUri, 'codeChallenge:', pending.codeChallenge?.slice(0, 10));

    if (!API_KEY) {
      console.error('[AUTH] handleApprove: no API_KEY configured, auto-approving');
      // No API key configured - auto-approve for testing
    } else if (api_key !== API_KEY) {
      console.error('[AUTH] handleApprove: invalid API key');
      return res.status(400).json({ error: 'access_denied', error_description: 'Invalid API key' });
    }

    this._pending.delete(state);
    const code = this._store.saveCode(
      pending.clientId,
      pending.codeChallenge,
      pending.redirectUri,
      pending.scopes,
      pending.state
    );
    console.error('[AUTH] handleApprove: code saved:', code?.slice(0, 8), 'expiresAt:', this._store._codes.get(code)?.expiresAt);

    // Redirect back to client with authorization code
    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (pending.state) redirectUrl.searchParams.set('state', pending.state);
    console.error('[AUTH] handleApprove: redirecting to:', redirectUrl.href);
    res.redirect(302, redirectUrl.href);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function pkceChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export { InMemoryClientsStore, InMemoryAuthStore };
