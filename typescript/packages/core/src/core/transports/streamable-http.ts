/**
 * Streamable HTTP Transport for MCP
 * 
 * Implements the MCP Streamable HTTP transport specification (2025-06-18).
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http
 * 
 * Features:
 * - Single MCP endpoint supporting both POST and GET
 * - POST for sending messages to server
 * - GET for SSE streams from server
 * - Session management with Mcp-Session-Id header
 * - Resumability support with Last-Event-ID
 * - Multiple concurrent client connections
 * - Protocol version header support
 */

import express, { Express, Request, Response } from 'express';
import { Server as HttpServer } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Factory that builds a fully-configured MCP server instance.
 * Each Streamable HTTP session gets its own server, since an SDK server can
 * only be connected to a single transport at a time.
 */
export type McpServerFactory = () => McpServer;

/** Handles legacy HTTP+SSE clients that open GET without a Streamable HTTP session id (e.g. Cursor). */
export type LegacySseHandler = (req: Request, res: Response) => Promise<void>;

export interface StreamableHttpTransportOptions {
  /**
   * Port to listen on (default: 3000)
   */
  port?: number;

  /**
   * Host to bind to (default: 'localhost' for security)
   */
  host?: string;

  /**
   * MCP endpoint path (default: '/mcp')
   */
  endpoint?: string;

  /**
   * Enable session management (default: true)
   */
  enableSessions?: boolean;

  /**
   * Session timeout in ms (default: 30 minutes)
   * Idle sessions are torn down after this period of inactivity.
   */
  sessionTimeout?: number;

  /**
   * Maximum number of concurrent MCP sessions (default: 1000).
   * Once reached, new `initialize` requests are rejected with HTTP 429 to
   * bound memory usage against unauthenticated session-creation floods.
   */
  maxSessions?: number;

  /**
   * Custom Express app (optional)
   */
  app?: Express;

  /**
   * Enable CORS (default: false for security)
   */
  enableCors?: boolean;
}

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

/**
 * Streamable HTTP host.
 *
 * This class owns the Express application (CORS, origin checks, OAuth discovery
 * routes, health, documentation page, legacy-SSE lifecycle) but delegates the
 * actual MCP protocol handling on `/mcp` to the official
 * `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport`. That transport
 * returns the JSON-RPC result on the POST response (or an SSE stream on the same
 * request), which is what modern MCP clients such as Cursor expect.
 */
export class StreamableHttpTransport {
  private app: Express;
  private server: HttpServer | null = null;
  private options: Required<Omit<StreamableHttpTransportOptions, 'app'>>;
  private getToolsCallback?: () => Promise<McpTool[]>;
  private serverConfig?: { name: string; version: string; description?: string };
  private logoBase64?: string;
  private codexLogoBase64?: string;
  private _routesRegistered = false;
  private mcpServerFactory?: McpServerFactory;
  private legacySseHandler?: LegacySseHandler;
  private mcpSessions: Map<string, McpSession> = new Map();
  private sessionCleanupInterval?: NodeJS.Timeout;

  constructor(options: StreamableHttpTransportOptions = {}) {
    this.options = {
      port: options.port || 3000,
      host: options.host || 'localhost',
      endpoint: options.endpoint || '/mcp',
      enableSessions: options.enableSessions === true, // Default to false for simpler clients
      sessionTimeout: options.sessionTimeout || 30 * 60 * 1000, // 30 minutes
      maxSessions: options.maxSessions || 1000, // Cap concurrent sessions to bound memory
      enableCors: options.enableCors !== false, // Default to true
    };

    this.app = options.app || express();

    // CRITICAL: Disable Express's automatic OPTIONS handling
    this.app.set('x-powered-by', false);

    // Enable trust proxy to respect X-Forwarded-* headers from reverse proxies
    // This is essential for HTTPS detection when behind a proxy
    this.app.set('trust proxy', true);

    // Load logo for documentation page
    this.loadLogo();

    this.setupMiddleware();
  }

  /**
   * Provide the factory used to build a configured MCP server per session.
   * Must be called before `start()`.
   */
  setMcpServerFactory(factory: McpServerFactory): void {
    this.mcpServerFactory = factory;
  }

  /**
   * Fallback for clients that speak legacy HTTP+SSE on GET /mcp (no mcp-session-id).
   * Streamable HTTP clients always begin with POST initialize instead.
   */
  setLegacySseHandler(handler: LegacySseHandler): void {
    this.legacySseHandler = handler;
  }

  /**
   * Load logo image as base64 for embedding in documentation page
   */
  private loadLogo(): void {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);

      // Try multiple paths:
      // 1. From dist/core/transports/streamable-http.js -> ../../../src/assets/nitrocloud.png (package source)
      // 2. From dist/core/transports/streamable-http.js -> ../../../../src/assets/nitrocloud.png (if in nitrostack package)
      // 3. From project root (user's project) -> src/assets/nitrocloud.png
      const possiblePaths = [
        join(__dirname, '../../../src/assets/logo.png'),
        join(__dirname, '../../../src/assets/nitrocloud.png'),
        join(__dirname, '../../../../src/assets/logo.png'),
        join(__dirname, '../../../../src/assets/nitrocloud.png'),
        join(process.cwd(), 'src/assets/logo.png'),
        join(process.cwd(), 'src/assets/nitrocloud.png'),
        join(process.cwd(), 'node_modules/nitrostack/src/assets/logo.png'),
        join(process.cwd(), 'node_modules/nitrostack/src/assets/nitrocloud.png'),
      ];

      let logoPath: string | null = null;
      for (const path of possiblePaths) {
        try {
          if (readFileSync(path, { flag: 'r' })) {
            logoPath = path;
            break;
          }
        } catch {
          continue;
        }
      }

      if (logoPath) {
        const logoBuffer = readFileSync(logoPath);
        this.logoBase64 = logoBuffer.toString('base64');
      } else {
        this.logoBase64 = undefined;
      }

      // Load Codex logo if present
      const possibleCodexPaths = [
        join(process.cwd(), 'codex-color.png'),
        join(process.cwd(), '../codex-color.png'),
        join(process.cwd(), '../../codex-color.png'),
        '/Users/admin/Desktop/sdk-env-oauth/codex-color.png',
      ];

      let codexPath: string | null = null;
      for (const path of possibleCodexPaths) {
        try {
          if (readFileSync(path, { flag: 'r' })) {
            codexPath = path;
            break;
          }
        } catch {
          continue;
        }
      }

      if (codexPath) {
        const codexBuffer = readFileSync(codexPath);
        this.codexLogoBase64 = codexBuffer.toString('base64');
      } else {
        this.codexLogoBase64 = undefined;
      }
    } catch (error) {
      // Logo is optional, continue without it
      this.logoBase64 = undefined;
      this.codexLogoBase64 = undefined;
    }
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // CORS (if enabled) - MUST be the very first middleware, handles ALL requests
    if (this.options.enableCors) {
      // Add CORS headers to ALL responses
      this.app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
        res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

        // Handle OPTIONS immediately
        if (req.method === 'OPTIONS') {
          res.status(200).end();
          return;
        }
        next();
      });
    }

    // Security: Validate Origin header to prevent DNS rebinding attacks (skip if CORS enabled)
    if (!this.options.enableCors) {
      this.app.use((req, res, next) => {
        const origin = req.get('Origin');
        const host = req.get('Host');

        if (origin && host) {
          const originHost = new URL(origin).host;
          if (originHost !== host && !this.isLocalhost(originHost)) {
            res.status(403).json({ error: 'Invalid Origin header' });
            return;
          }
        }
        next();
      });
    }

    // JSON parsing
    this.app.use(express.json());
  }

  /**
   * Setup MCP endpoint routes
   */
  private setupRoutes(): void {
    const endpoint = this.options.endpoint;

    // IMPORTANT: Add OPTIONS handler FIRST to override Express's auto-OPTIONS
    if (this.options.enableCors) {
      this.app.options(endpoint, (req, res) => {
        res.sendStatus(200);
      });
    }

    // MCP endpoint - POST (client->server messages), GET (server->client SSE
    // stream) and DELETE (session termination) are all delegated to the official
    // SDK Streamable HTTP transport, which owns the protocol semantics.
    this.app.post(endpoint, (req, res) => this.handleMcpRequest(req, res));
    this.app.get(endpoint, (req, res) => this.handleMcpRequest(req, res));
    this.app.delete(endpoint, (req, res) => this.handleMcpRequest(req, res));

    // Health check
    this.app.get(`${endpoint}/health`, (req, res) => {
      res.json({
        status: 'ok',
        transport: 'streamable-http',
        version: '2025-06-18',
        sessions: this.mcpSessions.size,
        uptime: process.uptime(),
      });
    });

    // Root documentation page (only in production mode when HTTP server runs)
    // This route is added at the end to avoid conflicts with MCP endpoints
    if (process.env.NODE_ENV !== 'development') {
      this.app.get('/', async (req, res) => {
        try {
          const tools = this.getToolsCallback ? await this.getToolsCallback() : [];

          // Get host from request headers (supports X-Forwarded-Host for reverse proxies)
          let host = req.get('x-forwarded-host') || req.get('host') || `${this.options.host}:${this.options.port}`;

          // In production, remove port if it's standard HTTP/HTTPS port
          // This handles cases where the server is behind a reverse proxy
          if (process.env.NODE_ENV === 'production') {
            // Remove port if it's 80 (HTTP) or 443 (HTTPS)
            host = host.replace(/:(80|443)$/, '');
          }

          // Support X-Forwarded-Proto for reverse proxies (production deployments)
          const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
          const baseUrl = `${protocol}://${host}`;
          const mcpEndpoint = `${baseUrl}${endpoint}`;

          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.send(this.generateDocumentationPage(tools, mcpEndpoint));
        } catch (error: unknown) {
          console.error('Error generating documentation page:', error);
          res.status(500).send('Error generating documentation page');
        }
      });
    }
  }

  /**
   * Delegate an `/mcp` request (POST/GET/DELETE) to the official SDK
   * Streamable HTTP transport. A new session (and its own MCP server instance)
   * is created on an `initialize` POST; subsequent requests are routed by the
   * `mcp-session-id` header.
   */
  private async handleMcpRequest(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = req.get('mcp-session-id');
      let session = sessionId ? this.mcpSessions.get(sessionId) : undefined;

      if (!session) {
        if (req.method === 'POST' && this.isInitializeRequest(req.body)) {
          // Bound memory: reject new sessions once at capacity. This defends
          // against unauthenticated `initialize` floods exhausting memory.
          if (this.mcpSessions.size >= this.options.maxSessions) {
            res.status(429).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Too many sessions: server at capacity, retry later',
              },
              id: null,
            });
            return;
          }
          session = await this.createSession();
        } else if (req.method === 'GET' && this.legacySseHandler) {
          // Cursor and other legacy SSE clients open GET first; Streamable HTTP
          // always starts with POST initialize. Delegate when a handler is wired.
          await this.legacySseHandler(req, res);
          return;
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: no valid session ID provided',
            },
            id: null,
          });
          return;
        }
      }

      // Refresh activity so the idle sweeper only reaps genuinely stale sessions.
      session.lastActivity = Date.now();

      // Cast around the SDK's expected node req/res types: Express augments
      // Request with nitrostack's own `auth` shape which differs from the SDK's.
      await session.transport.handleRequest(req as any, res as any, req.body);
    } catch (error: unknown) {
      console.error('MCP request error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null,
        });
      }
    }
  }

  /**
   * Create a new MCP session: a fresh configured MCP server connected to a new
   * official Streamable HTTP transport. The transport registers itself in the
   * session map once it has negotiated a session id, and removes itself on close.
   */
  private async createSession(): Promise<McpSession> {
    if (!this.mcpServerFactory) {
      throw new Error('StreamableHttpTransport: MCP server factory not set');
    }

    const server = this.mcpServerFactory();
    // Build the session object first so `lastActivity` is a shared, mutable
    // reference visible to both the session map and the idle sweeper.
    const session: McpSession = { server, transport: undefined as unknown as StreamableHTTPServerTransport, lastActivity: Date.now() };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => uuidv4(),
      onsessioninitialized: (sid: string) => {
        this.mcpSessions.set(sid, session);
      },
    });
    session.transport = transport;

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        this.mcpSessions.delete(sid);
      }
      server.close().catch(() => {
        // ignore close errors
      });
    };

    await server.connect(transport);
    return session;
  }

  /**
   * Periodically tear down sessions that have been idle longer than
   * `sessionTimeout`. Prevents unbounded memory growth from clients that
   * initialize but never disconnect or send DELETE.
   */
  private startSessionCleanup(): void {
    if (this.sessionCleanupInterval) {
      return;
    }
    this.sessionCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [sid, session] of this.mcpSessions.entries()) {
        if (now - session.lastActivity > this.options.sessionTimeout) {
          this.mcpSessions.delete(sid);
          session.transport.close().catch(() => {
            // ignore close errors
          });
          session.server.close().catch(() => {
            // ignore close errors
          });
        }
      }
    }, 60_000); // sweep once a minute
    // Do not keep the event loop (and process) alive just for the sweeper.
    this.sessionCleanupInterval.unref?.();
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    if (!this._routesRegistered) {
      this.setupRoutes();
      this._routesRegistered = true;
    }

    this.startSessionCleanup();

    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error) => {
        console.error(`Failed to start Streamable HTTP transport: ${error.message}`);
        this.server = null;
        reject(error);
      };

      try {
        const server = this.app.listen(this.options.port, this.options.host);

        server.once('error', errorHandler);

        server.once('listening', () => {
          server.removeListener('error', errorHandler);

          server.on('error', (error) => {
            console.error('Streamable HTTP server error:', error.message);
          });

          this.server = server;

          console.error(`🌐 MCP Streamable HTTP transport listening on http://${this.options.host}:${this.options.port}${this.options.endpoint}`);
          console.error(`   Protocol: MCP 2025-06-18`);
          console.error(`   Sessions: ${this.options.enableSessions ? 'enabled' : 'disabled'}`);

          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Register additional HTTP routes
   * Allows modules (like OAuthModule) to add custom endpoints
   */
  on(path: string, handler: (req: any, res: any) => void): void {
    this.app.get(path, handler);
    this.app.post(path, handler);
    this.app.options(path, handler);
  }

  /**
   * Close the transport: tear down all live MCP sessions and the HTTP server.
   */
  async close(): Promise<void> {
    // Stop the idle sweeper first so it can't race with teardown.
    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
      this.sessionCleanupInterval = undefined;
    }

    // Close all live MCP sessions (SDK transports + their servers)
    const sessions = Array.from(this.mcpSessions.values());
    this.mcpSessions.clear();
    for (const { server, transport } of sessions) {
      try {
        await transport.close();
      } catch {
        // ignore
      }
      try {
        await server.close();
      } catch {
        // ignore
      }
    }

    // Close HTTP server
    if (this.server) {
      return new Promise((resolve) => {
        const server = this.server!;
        this.server = null;

        server.closeAllConnections?.();

        server.close((err) => {
          if (err) {
            console.error('HTTP server close error:', err.message);
          }
          resolve();
        });
      });
    }
  }

  /**
   * Whether a parsed JSON-RPC body is an `initialize` request.
   */
  private isInitializeRequest(message: unknown): boolean {
    return (
      !!message &&
      typeof message === 'object' &&
      (message as { method?: unknown }).method === 'initialize'
    );
  }

  private isLocalhost(host: string): boolean {
    // Extract hostname without port (handles both IPv4 and IPv6 formats)
    let hostname = host;
    if (host.includes('[') && host.includes(']')) {
      // IPv6 with port format: [::1]:3000
      hostname = host.substring(host.indexOf('[') + 1, host.indexOf(']'));
    } else if (host.includes(':') && (host.match(/:/g) || []).length > 1) {
      // Raw IPv6: ::1
      hostname = host;
    } else {
      // IPv4 or hostname: localhost:3000 or 127.0.0.1:3000
      hostname = host.split(':')[0];
    }

    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  }

  /**
   * Get the Express app (for adding custom routes)
   */
  getApp(): Express {
    return this.app;
  }

  /**
   * Set callback to get tools list for documentation page
   */
  setToolsCallback(callback: () => Promise<McpTool[]>): void {
    this.getToolsCallback = callback;
  }

  /**
   * Set server configuration for documentation page
   */
  setServerConfig(config: { name: string; version: string; description?: string }): void {
    this.serverConfig = config;
  }

  /**
   * Generate HTML documentation page
   */
  private generateDocumentationPage(tools: McpTool[], mcpEndpoint: string): string {
    const rawServerName = this.serverConfig?.name || 'NitroStack MCP Server';
    const formatTitle = (name: string) => {
      if (name.includes('/') || name.includes('\\')) return name;
      return name
        .split(/[-_]+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    };
    const serverName = formatTitle(rawServerName);
    const serverVersion = this.serverConfig?.version || '1.0.0';
    const serverDescription = this.serverConfig?.description || 'A powerful MCP server built with NitroStack';

    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${serverName} - MCP Server Documentation</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700;800&family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    /* Premium Dark & Light Themes */
    :root {
      --bg-gradient: radial-gradient(circle at 10% 20%, #0f172a 0%, #020617 90%);
      --bg-card: rgba(30, 41, 59, 0.45);
      --bg-card-hover: rgba(30, 41, 59, 0.65);
      --border-color: rgba(255, 255, 255, 0.08);
      --border-color-hover: rgba(99, 102, 241, 0.4);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --primary-rgb: 99, 102, 241;
      --accent: #a855f7;
      --success: #10b981;
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-display: 'Space Grotesk', sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }
    
    .light {
      --bg-gradient: radial-gradient(circle at 10% 20%, #f8fafc 0%, #e2e8f0 90%);
      --bg-card: rgba(255, 255, 255, 0.65);
      --bg-card-hover: rgba(255, 255, 255, 0.85);
      --border-color: rgba(15, 23, 42, 0.08);
      --border-color-hover: rgba(79, 70, 229, 0.4);
      --text-main: #0f172a;
      --text-muted: #475569;
      --primary: #4f46e5;
      --primary-hover: #3730a3;
      --primary-rgb: 79, 70, 229;
      --accent: #7e22ce;
      --success: #059669;
      --font-display: 'Space Grotesk', sans-serif;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: var(--font-sans);
      background: var(--bg-gradient);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 3rem 1.5rem;
      transition: background 0.3s, color 0.3s;
    }
    
    .wrapper {
      width: 100%;
      max-width: 960px;
    }
    
    /* Top Controls */
    .controls {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 1.5rem;
    }
    
    .btn-toggle {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      padding: 0.5rem 1rem;
      border-radius: 9999px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      backdrop-filter: blur(12px);
      transition: all 0.2s;
    }
    .btn-toggle:hover {
      border-color: var(--primary);
      box-shadow: 0 0 12px rgba(var(--primary-rgb), 0.15);
    }
    
    /* Premium Header */
    header {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 3rem 2rem;
      margin-bottom: 2rem;
      backdrop-filter: blur(16px);
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      position: relative;
      overflow: hidden;
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.05);
    }
    
    header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: linear-gradient(90deg, var(--primary), var(--accent));
    }
    
    .logo-container {
      background: rgba(255, 255, 255, 0.04);
      border-radius: 20px;
      padding: 1rem;
      margin-bottom: 1.5rem;
      border: 1px solid var(--border-color);
      display: inline-flex;
      box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.1);
    }
    
    .logo {
      height: 56px;
      width: auto;
      object-fit: contain;
    }
    
    .title {
      font-family: var(--font-display);
      font-size: 2.5rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      margin-bottom: 0.5rem;
      line-height: 1.2;
    }
    
    .version-badge {
      display: inline-block;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 600;
      background: rgba(var(--primary-rgb), 0.1);
      color: var(--primary);
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      border: 1px solid rgba(var(--primary-rgb), 0.2);
      margin-bottom: 1.25rem;
    }
    
    .description {
      font-size: 1.05rem;
      color: var(--text-muted);
      max-width: 600px;
      line-height: 1.6;
    }
    
    /* Connection Panel with Tabs */
    .connection-panel {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 2.25rem;
      margin-bottom: 2rem;
      backdrop-filter: blur(16px);
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.05);
    }
    
    .section-title {
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 1.25rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .tab-header {
      display: flex;
      border-bottom: 1px solid var(--border-color);
      gap: 1.25rem;
      margin-bottom: 1.5rem;
    }
    
    .tab-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      padding: 0.75rem 0.25rem;
      font-family: var(--font-sans);
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      position: relative;
      transition: color 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    .tab-btn:hover {
      color: var(--text-main);
    }
    .tab-btn.active {
      color: var(--primary);
    }
    .tab-btn.active::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--primary);
    }
    
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    
    .code-container {
      background: #020617;
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      padding: 1.25rem;
      position: relative;
      overflow-x: auto;
      margin-top: 0.75rem;
    }
    .code-container pre {
      font-family: var(--font-mono);
      font-size: 0.825rem;
      color: #93c5fd;
      line-height: 1.5;
    }
    
    .btn-copy {
      position: absolute;
      top: 0.75rem;
      right: 0.75rem;
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #e2e8f0;
      padding: 0.35rem 0.7rem;
      font-size: 0.75rem;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.25rem;
      transition: all 0.2s;
    }
    .btn-copy:hover {
      background: rgba(255, 255, 255, 0.15);
      color: white;
    }
    
    /* Search Box */
    .search-container {
      position: relative;
      margin-bottom: 1.5rem;
    }
    .search-input {
      width: 100%;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 1rem 1.25rem 1rem 3.25rem;
      color: var(--text-main);
      font-family: var(--font-sans);
      font-size: 0.95rem;
      transition: all 0.2s;
      outline: none;
    }
    .search-input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.15);
    }
    .search-icon {
      position: absolute;
      left: 1.25rem;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      pointer-events: none;
      width: 1.25rem;
      height: 1.25rem;
    }
    
    /* Tools Grid */
    .tools-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
      gap: 1.25rem;
      margin-bottom: 4rem;
    }
    .tool-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      padding: 1.5rem;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      backdrop-filter: blur(12px);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.02);
    }
    .tool-card:hover {
      border-color: var(--border-color-hover);
      box-shadow: 0 12px 30px rgba(var(--primary-rgb), 0.08);
      transform: translateY(-4px);
    }
    .tool-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 0.75rem;
      gap: 0.5rem;
    }
    .tool-name {
      font-weight: 700;
      font-size: 1.1rem;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .tool-description {
      font-size: 0.875rem;
      color: var(--text-muted);
      line-height: 1.6;
      flex-grow: 1;
      margin-bottom: 1.5rem;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      font-size: 0.65rem;
      font-weight: 800;
      padding: 0.25rem 0.5rem;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge.widget {
      background: rgba(168, 85, 247, 0.1);
      color: var(--accent);
      border: 1px solid rgba(168, 85, 247, 0.2);
    }
    
    .schema-toggle {
      background: rgba(var(--primary-rgb), 0.05);
      border: 1px solid rgba(var(--primary-rgb), 0.1);
      color: var(--primary);
      padding: 0.55rem 1rem;
      font-family: var(--font-sans);
      font-size: 0.8rem;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.35rem;
      transition: all 0.2s;
    }
    .schema-toggle:hover {
      background: rgba(var(--primary-rgb), 0.1);
      border-color: var(--primary);
    }
    
    .schema-content {
      display: none;
      margin-top: 1rem;
      border-top: 1px solid var(--border-color);
      padding-top: 1rem;
    }
    .schema-content.active {
      display: block;
      animation: slideDown 0.2s ease-out;
    }
    
    .schema-content pre {
      background: #020617;
      border: 1px solid rgba(255, 255, 255, 0.05);
      padding: 1rem;
      border-radius: 8px;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 0.775rem;
      color: #38bdf8;
      line-height: 1.5;
    }
    
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    /* Footer */
    footer {
      text-align: center;
      color: var(--text-muted);
      font-size: 0.85rem;
      margin-top: auto;
      padding: 2.5rem 0;
      border-top: 1px solid var(--border-color);
      width: 100%;
    }
    footer a {
      color: var(--primary);
      text-decoration: none;
      font-weight: 600;
    }
    footer a:hover {
      text-decoration: underline;
    }

    /* Claude Custom Connector Mockup Styles */
    .claude-dialog-container {
      background-color: #201f1d;
      border: 1px solid #2d2c29;
      border-radius: 12px;
      padding: 24px;
      width: 100%;
      max-width: 500px;
      color: #e3e2e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      margin: 1.5rem auto;
      position: relative;
    }

    .claude-dialog-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .claude-dialog-title-container {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .claude-dialog-title {
      font-size: 20px;
      font-weight: 600;
      color: #f5f4f2;
    }

    .claude-beta-badge {
      background-color: #383733;
      color: #8c8a84;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      letter-spacing: 0.5px;
    }

    .claude-close-btn {
      color: #8c8a84;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      transition: background-color 0.2s;
    }

    .claude-close-btn:hover {
      background-color: #2d2c29;
      color: #f5f4f2;
    }

    .claude-dialog-desc {
      font-size: 13.5px;
      line-height: 1.5;
      color: #9b9993;
      margin-bottom: 20px;
    }

    .claude-dialog-desc a {
      color: #58a6ff;
      text-decoration: underline;
    }

    .claude-input-group {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 20px;
    }

    .claude-input-wrapper {
      position: relative;
      width: 100%;
    }

    .claude-input {
      width: 100%;
      background-color: #2c2b27;
      border: 1px solid #3c3b37;
      border-radius: 8px;
      padding: 12px 14px;
      color: #f5f4f2;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .claude-input::placeholder {
      color: #706e67;
    }

    .claude-input:focus-within, .claude-input.active-input {
      border-color: #3890ff;
      box-shadow: 0 0 0 1px #3890ff;
    }

    .claude-input-wrapper .btn-copy-input {
      position: absolute;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #e3e2e0;
      padding: 4px 8px;
      font-size: 11px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .claude-input-wrapper .btn-copy-input:hover {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.25);
    }

    .claude-advanced-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13.5px;
      font-weight: 500;
      color: #e3e2e0;
      cursor: pointer;
      margin-bottom: 24px;
      user-select: none;
    }

    .claude-dialog-caution {
      font-size: 12px;
      line-height: 1.5;
      color: #8c8a84;
      margin-bottom: 20px;
      padding-top: 4px;
    }

    .claude-dialog-footer-text {
      font-size: 12px;
      color: #8c8a84;
      margin-bottom: 24px;
      border-top: 1px solid #2d2c29;
      padding-top: 16px;
    }

    .claude-dialog-footer-text a {
      color: #58a6ff;
      text-decoration: underline;
    }

    .claude-dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }

    .claude-btn {
      padding: 8px 16px;
      font-size: 13.5px;
      font-weight: 500;
      border-radius: 8px;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }

    .claude-btn-cancel {
      background-color: #2c2b27;
      color: #e3e2e0;
      border: 1px solid #3c3b37;
    }

    .claude-btn-cancel:hover {
      background-color: #383733;
    }

    .claude-btn-add {
      background-color: #e3e2e0;
      color: #161513;
    }

    .claude-btn-add:hover {
      background-color: #ffffff;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="controls">
      <button class="btn-toggle" onclick="toggleTheme()" id="theme-btn">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:1.15rem;height:1.15rem;">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
        </svg>
        <span>Toggle Theme</span>
      </button>
    </div>

    <header>
      ${this.logoBase64 ? `
      <div class="logo-container">
        <img src="data:image/png;base64,${this.logoBase64}" alt="Logo" class="logo">
      </div>
      ` : ''}
      <h1 class="title">${serverName}</h1>
      <span class="version-badge">v${serverVersion}</span>
      <p class="description">${serverDescription}</p>
    </header>

    <div class="connection-panel">
      <div class="section-title">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:1.25rem;height:1.25rem;color:var(--primary);">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z" />
        </svg>
        <span>Connection Setup</span>
      </div>

      <div class="tab-header">
        <button class="tab-btn active" onclick="switchTab('cursor')">
          <svg fill="none" height="14" viewBox="0 0 545 545" width="14" xmlns="http://www.w3.org/2000/svg" style="color: currentColor;"><g fill="currentColor"><path d="m466.383 137.073-206.469-119.2034c-6.63-3.8287-14.811-3.8287-21.441 0l-206.4586 119.2034c-5.5734 3.218-9.0144 9.169-9.0144 15.615v240.375c0 6.436 3.441 12.397 9.0144 15.615l206.4686 119.203c6.63 3.829 14.811 3.829 21.441 0l206.468-119.203c5.574-3.218 9.015-9.17 9.015-15.615v-240.375c0-6.436-3.441-12.397-9.015-15.615zm-12.969 25.25-199.316 345.223c-1.347 2.326-4.904 1.376-4.904-1.319v-226.048c0-4.517-2.414-8.695-6.33-10.963l-195.7577-113.019c-2.3263-1.347-1.3764-4.905 1.3182-4.905h398.6305c5.661 0 9.199 6.136 6.368 11.041h-.009z"></path></g></svg>
          <span>Cursor</span>
        </button>
        <button class="tab-btn" onclick="switchTab('claude')">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" role="img" aria-label="Claude Logo"><path d="M11.376 24L10.776 23.544L10.44 22.8L10.776 21.312L11.16 19.392L11.472 17.856L11.76 15.96L11.928 15.336L11.904 15.288L11.784 15.312L10.344 17.28L8.16 20.232L6.432 22.056L6.024 22.224L5.304 21.864L5.376 21.192L5.784 20.616L8.16 17.568L9.6 15.672L10.536 14.592L10.512 14.448H10.464L4.128 18.576L3 18.72L2.496 18.264L2.568 17.52L2.808 17.28L4.704 15.96L9.432 13.32L9.504 13.08L9.432 12.96H9.192L8.4 12.912L5.712 12.84L3.384 12.744L1.104 12.624L0.528 12.504L0 11.784L0.048 11.424L0.528 11.112L1.224 11.16L2.736 11.28L5.016 11.424L6.672 11.52L9.12 11.784H9.504L9.552 11.616L9.432 11.52L9.336 11.424L6.96 9.84L4.416 8.16L3.072 7.176L2.352 6.672L1.992 6.216L1.848 5.208L2.496 4.488L3.384 4.56L3.6 4.608L4.488 5.304L6.384 6.768L8.88 8.616L9.24 8.904L9.408 8.808V8.736L9.24 8.472L7.896 6.024L6.456 3.528L5.808 2.496L5.64 1.872C5.576 1.656 5.544 1.416 5.544 1.152L6.288 0.144001L6.696 0L7.704 0.144001L8.112 0.504001L8.736 1.92L9.72 4.152L11.28 7.176L11.736 8.088L11.976 8.904L12.072 9.168H12.24V9.024L12.36 7.296L12.6 5.208L12.84 2.52L12.912 1.752L13.296 0.840001L14.04 0.360001L14.616 0.624001L15.096 1.32L15.024 1.752L14.76 3.6L14.184 6.504L13.824 8.472H14.04L14.28 8.208L15.264 6.912L16.92 4.848L17.64 4.032L18.504 3.12L19.056 2.688H20.088L20.832 3.816L20.496 4.992L19.44 6.336L18.552 7.464L17.28 9.168L16.512 10.536L16.584 10.632H16.752L19.608 10.008L21.168 9.744L22.992 9.432L23.832 9.816L23.928 10.2L23.592 11.016L21.624 11.496L19.32 11.952L15.888 12.768L15.84 12.792L15.888 12.864L17.424 13.008L18.096 13.056H19.728L22.752 13.272L23.544 13.8L24 14.424L23.928 14.928L22.704 15.528L21.072 15.144L17.232 14.232L15.936 13.92H15.744V14.016L16.848 15.096L18.84 16.896L21.36 19.224L21.48 19.8L21.168 20.28L20.832 20.232L18.624 18.552L17.76 17.808L15.84 16.2H15.72V16.368L16.152 17.016L18.504 20.544L18.624 21.624L18.456 21.96L17.832 22.176L17.184 22.056L15.792 20.136L14.376 17.952L13.224 16.008L13.104 16.104L12.408 23.352L12.096 23.712L11.376 24Z" fill="var(--cds-clay, #d97757)"/></svg>
          <span>Claude</span>
        </button>
        <button class="tab-btn" onclick="switchTab('antigravity')">
          <svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 0 24 24" width="14" style="flex:none;line-height:1;color:currentColor;"><title>Antigravity</title><mask height="23" id="lobe-icons-antigravity-0-_R_0_" maskUnits="userSpaceOnUse" width="24" x="0" y="1"><path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" fill="#fff"/></mask><g mask="url(#lobe-icons-antigravity-0-_R_0_)"><g filter="url(#lobe-icons-antigravity-1-_R_0_)"><path d="M-1.018-3.992c-.408 3.591 2.686 6.89 6.91 7.37 4.225.48 7.98-2.043 8.387-5.633.408-3.59-2.686-6.89-6.91-7.37-4.225-.479-7.98 2.043-8.387 5.633z" fill="#FFE432"/></g><g filter="url(#lobe-icons-antigravity-2-_R_0_)"><path d="M15.269 7.747c1.058 4.557 5.691 7.374 10.348 6.293 4.657-1.082 7.575-5.653 6.516-10.21-1.058-4.556-5.691-7.374-10.348-6.292-4.657 1.082-7.575 5.653-6.516 10.21z" fill="#FC413D"/></g><g filter="url(#lobe-icons-antigravity-3-_R_0_)"><path d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z" fill="#00B95C"/></g><g filter="url(#lobe-icons-antigravity-4-_R_0_)"><path d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z" fill="#00B95C"/></g><g filter="url(#lobe-icons-antigravity-5-_R_0_)"><path d="M-7.608 14.703c3.352 3.424 9.126 3.208 12.896-.483 3.77-3.69 4.108-9.459.756-12.883C2.69-2.087-3.083-1.871-6.853 1.82c-3.77 3.69-4.108 9.458-.755 12.883z" fill="#00B95C"/></g><g filter="url(#lobe-icons-antigravity-6-_R_0_)"><path d="M9.932 27.617c1.04 4.482 5.384 7.303 9.7 6.3 4.316-1.002 6.971-5.448 5.93-9.93-1.04-4.483-5.384-7.304-9.7-6.301-4.316 1.002-6.971 5.448-5.93 9.93z" fill="#3186FF"/></g><g filter="url(#lobe-icons-antigravity-7-_R_0_)"><path d="M2.572-8.185C.392-3.329 2.778 2.472 7.9 4.771c5.122 2.3 11.042.227 13.222-4.63 2.18-4.855-.205-10.656-5.327-12.955-5.122-2.3-11.042-.227-13.222 4.63z" fill="#FBBC04"/></g><g filter="url(#lobe-icons-antigravity-8-_R_0_)"><path d="M-3.267 38.686c-5.277-2.072 3.742-19.117 5.984-24.83 2.243-5.712 8.34-8.664 13.616-6.592 5.278 2.071 11.533 13.482 9.29 19.195-2.242 5.713-23.613 14.298-28.89 12.227z" fill="#3186FF"/></g><g filter="url(#lobe-icons-antigravity-9-_R_0_)"><path d="M28.71 17.471c-1.413 1.649-5.1.808-8.236-1.878-3.135-2.687-4.531-6.201-3.118-7.85 1.412-1.649 5.1-.808 8.235 1.878s4.532 6.2 3.119 7.85z" fill="#749BFF"/></g><g filter="url(#lobe-icons-antigravity-10-_R_0_)"><path d="M18.163 9.077c5.81 3.93 12.502 4.19 14.946.577 2.443-3.612-.287-9.727-6.098-13.658-5.81-3.931-12.502-4.19-14.946-.577-2.443 3.612.287 9.727 6.098 13.658z" fill="#FC413D"/></g><g filter="url(#lobe-icons-antigravity-11-_R_0_)"><path d="M-.915 2.684c-1.44 3.473-.97 6.967 1.05 7.804 2.02.837 4.824-1.3 6.264-4.772 1.44-3.473.97-6.967-1.05-7.804-2.02-.837-4.824 1.3-6.264 4.772z" fill="#FFEE48"/></g></g><defs><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="17.587" id="lobe-icons-antigravity-1-_R_0_" width="19.838" x="-3.288" y="-11.917"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="1.117"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="38.565" id="lobe-icons-antigravity-2-_R_0_" width="38.9" x="4.251" y="-13.493"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="5.4"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="36.517" id="lobe-icons-antigravity-3-_R_0_" width="40.955" x="-21.889" y="-10.592"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.591"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="36.517" id="lobe-icons-antigravity-4-_R_0_" width="40.955" x="-21.889" y="-10.592"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.591"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="36.595" id="lobe-icons-antigravity-5-_R_0_" width="36.632" x="-19.099" y="-10.278"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.591"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="34.087" id="lobe-icons-antigravity-6-_R_0_" width="33.533" x=".981" y="8.758"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.363"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="35.276" id="lobe-icons-antigravity-7-_R_0_" width="35.978" x="-6.143" y="-21.659"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.954"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="46.523" id="lobe-icons-antigravity-8-_R_0_" width="45.114" x="-11.96" y="-.46"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.531"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="24.054" id="lobe-icons-antigravity-9-_R_0_" width="25.094" x="10.485" y=".58"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.159"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="30.007" id="lobe-icons-antigravity-10-_R_0_" width="33.508" x="5.833" y="-12.467"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="2.669"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="26.151" id="lobe-icons-antigravity-11-_R_0_" width="22.194" x="-8.355" y="-8.876"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.303"/></filter></defs></svg>
          <span>Antigravity</span>
        </button>
        <button class="tab-btn" onclick="switchTab('codex')">
          ${this.codexLogoBase64 ? `
          <img src="data:image/png;base64,${this.codexLogoBase64}" alt="Codex Logo" style="width:14px;height:14px;flex:none;object-fit:contain;border-radius:2px;">
          ` : `
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="flex:none;line-height:1;width:14px;height:14px;color:currentColor;">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
          </svg>
          `}
          <span>Codex</span>
        </button>
        <button class="tab-btn" onclick="switchTab('sse')">Raw SSE</button>
      </div>

      <!-- Cursor Connection Tab -->
      <div class="tab-content active" id="tab-cursor">
        <p style="font-size: 0.9rem; margin-bottom: 0.75rem; color: var(--text-muted);">
          Add via Cursor Settings UI (<strong>Settings > Features > MCP > Add New MCP Server</strong>):
        </p>
        <div class="code-container">
          <button class="btn-copy" onclick="copyText('cursor-config')">Copy JSON</button>
          <pre id="cursor-config">{
  "mcpServers": {
    // your other mcp servers
    "${serverName.toLowerCase().replace(/\s+/g, '-')}": {
      "url": "${mcpEndpoint}"
    }
  }
}</pre>
        </div>
      </div>

      <!-- Claude Connection Tab -->
      <div class="tab-content" id="tab-claude">
        <p style="font-size: 0.9rem; margin-bottom: 1rem; color: var(--text-muted);">
          Connect remote tools directly via Claude's Web UI:
        </p>
        
        <div class="claude-dialog-container">
          <div class="claude-dialog-header">
            <div class="claude-dialog-title-container">
              <span class="claude-dialog-title">Add custom connector</span>
              <span class="claude-beta-badge">BETA</span>
            </div>
            <div class="claude-close-btn">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:16px;height:16px;">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </div>
          </div>
          
          <div class="claude-dialog-desc">
            Connect Claude to your data and tools. <a href="https://support.anthropic.com" target="_blank">Learn more about connectors</a> or get started with <a href="https://support.anthropic.com" target="_blank">pre-built ones</a>.
          </div>
          
          <div class="claude-input-group">
            <div class="claude-input-wrapper">
              <input type="text" class="claude-input" readonly value="${serverName.toLowerCase().replace(/\s+/g, '-')}">
            </div>
            <div class="claude-input-wrapper">
              <input type="text" class="claude-input active-input" id="claude-connector-url" readonly value="${mcpEndpoint}">
              <button class="btn-copy-input" onclick="copyText('claude-connector-url')">Copy</button>
            </div>
          </div>
          
          <div class="claude-advanced-toggle">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" style="width:12px;height:12px;">
              <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
            <span>Advanced settings</span>
          </div>
          
          <div class="claude-dialog-caution">
            Only use connectors from developers you trust. Anthropic does not control which tools developers make available and cannot verify that they will work as intended or that they won't change.
          </div>
          
          <div class="claude-dialog-footer-text">
            Building an MCP server? <a href="https://github.com/modelcontextprotocol" target="_blank">Report issues and subscribe to updates here</a>
          </div>
          
          <div class="claude-dialog-actions">
            <button class="claude-btn claude-btn-cancel">Cancel</button>
            <button class="claude-btn claude-btn-add">Add</button>
          </div>
        </div>
      </div>

      <!-- Antigravity Connection Tab -->
      <div class="tab-content" id="tab-antigravity">
        <p style="font-size: 0.9rem; margin-bottom: 0.75rem; color: var(--text-muted);">
          Add the following configuration block under <code>mcpServers</code> in your Antigravity configuration file (<code>~/.gemini/config/mcp_config.json</code>):
        </p>
        <div class="code-container">
          <button class="btn-copy" onclick="copyText('antigravity-config')">Copy JSON</button>
          <pre id="antigravity-config">{
  "mcpServers": {
    // your other mcp servers
    "${serverName.toLowerCase().replace(/\s+/g, '-')}": {
      "serverUrl": "${mcpEndpoint}"
    }
  }
}</pre>
        </div>
      </div>

      <!-- Codex Connection Tab -->
      <div class="tab-content" id="tab-codex">
        <p style="font-size: 0.9rem; margin-bottom: 0.75rem; color: var(--text-muted);">
          Add the following configuration block to your Codex configuration file (<code>~/.codex/config.toml</code>):
        </p>
        <div class="code-container">
          <button class="btn-copy" onclick="copyText('codex-config')">Copy TOML</button>
          <pre id="codex-config">[mcp_servers.${serverName.toLowerCase().replace(/\s+/g, '-')}]
url = "${mcpEndpoint}"</pre>
        </div>
      </div>

      <!-- Raw SSE Tab -->
      <div class="tab-content" id="tab-sse">
        <p style="font-size: 0.9rem; margin-bottom: 0.75rem; color: var(--text-muted);">
          Connect directly using the Server-Sent Events endpoint:
        </p>
        <div class="code-container">
          <button class="btn-copy" onclick="copyText('sse-endpoint')">Copy Endpoint</button>
          <pre id="sse-endpoint">${mcpEndpoint}</pre>
        </div>
      </div>
    </div>

    <div class="section-title">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:1.25rem;height:1.25rem;color:var(--primary);">
        <path stroke-linecap="round" stroke-linejoin="round" d="M11.42 15.17 17.25 21A2.67 2.67 0 1 1 13.5 17.25l-5.83-5.83m0 0a2.67 2.67 0 1 1-3.75-3.75 2.67 2.67 0 0 1 3.75 3.75Zm5.83 5.83V12m0 0h5.25m-5.25 0V6.75" />
      </svg>
      <span>Available Tools</span>
    </div>

    <div class="search-container">
      <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <input type="text" class="search-input" id="search" placeholder="Search tools by name or description..." oninput="filterTools()">
    </div>

    ${tools.length > 0 ? `
      <div class="tools-grid" id="tools-container">
        ${tools.map((tool, idx) => {
      return `
            <div class="tool-card" data-name="${this.escapeHtml(tool.name).toLowerCase()}" data-desc="${this.escapeHtml(tool.description || '').toLowerCase()}">
              <div class="tool-header">
                <div class="tool-name-container">
                  <span class="tool-name">${this.escapeHtml(tool.name)}</span>
                </div>
              </div>
              <p class="tool-description">${this.escapeHtml(tool.description || 'No description available')}</p>
              ${tool.inputSchema ? `
                <button class="schema-toggle" onclick="toggleSchema(${idx})">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:0.9rem;height:0.9rem;">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
                  </svg>
                  <span>View Input Schema</span>
                </button>
                <div class="schema-content" id="schema-${idx}">
                  <pre>${this.escapeHtml(JSON.stringify(tool.inputSchema, null, 2))}</pre>
                </div>
              ` : ''}
            </div>
          `;
    }).join('')}
      </div>
    ` : `
      <div class="empty-state">
        <p>No tools are currently registered on this server.</p>
      </div>
    `}

    <footer>
      <p>Powered by <a href="https://nitrostack.ai" target="_blank" rel="noopener noreferrer">NitroStack</a> - The TypeScript MCP Framework</p>
    </footer>
  </div>

  <script>
    // Theme Toggle State
    function toggleTheme() {
      const html = document.documentElement;
      if (html.classList.contains('light')) {
        html.classList.remove('light');
        html.classList.add('dark');
        localStorage.setItem('theme', 'dark');
      } else {
        html.classList.remove('dark');
        html.classList.add('light');
        localStorage.setItem('theme', 'light');
      }
    }
    
    // Set Initial Theme
    (function() {
      const savedTheme = localStorage.getItem('theme') || 'dark';
      document.documentElement.className = savedTheme;
    })();

    // Dynamically update localhost to current origin if served over HTTP/HTTPS
    (function() {
      if (window.location.protocol.startsWith('http')) {
        const currentOrigin = window.location.origin;
        const sseEl = document.getElementById('sse-endpoint');
        if (!sseEl) return;
        
        let endpointPath = '/mcp';
        try {
          const urlObj = new URL(sseEl.innerText.trim());
          endpointPath = urlObj.pathname;
        } catch (e) {}
        
        const dynamicUrl = currentOrigin + endpointPath;
        
        const updateElementUrl = (id, targetUrl) => {
          const el = document.getElementById(id);
          if (el) {
            el.innerHTML = el.innerHTML.replace(/https?:\\/\\/[^\\s"]+/g, targetUrl);
          }
        };
        
        updateElementUrl('cursor-config', dynamicUrl);
        updateElementUrl('antigravity-config', dynamicUrl);
        updateElementUrl('codex-config', dynamicUrl);
        updateElementUrl('sse-endpoint', dynamicUrl);
      }
    })();

    // Tab Switching
    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      
      const activeBtn = Array.from(document.querySelectorAll('.tab-btn')).find(btn => btn.textContent.toLowerCase().includes(tabId));
      if (activeBtn) activeBtn.classList.add('active');
      
      const activeContent = document.getElementById('tab-' + tabId);
      if (activeContent) activeContent.classList.add('active');
    }

    // Copy to Clipboard
    function copyText(elementId) {
      const el = document.getElementById(elementId);
      const text = el.tagName === 'INPUT' ? el.value : el.innerText;
      navigator.clipboard.writeText(text).then(() => {
        const btn = el.parentNode.querySelector('.btn-copy') || el.parentNode.querySelector('.btn-copy-input');
        const originalText = btn.innerText;
        btn.innerText = 'Copied!';
        btn.style.background = 'rgba(16, 185, 129, 0.2)';
        btn.style.borderColor = '#10b981';
        setTimeout(() => {
          btn.innerText = originalText;
          btn.style.background = '';
          btn.style.borderColor = '';
        }, 1500);
      });
    }

    // Toggle Schema Visibility
    function toggleSchema(index) {
      const content = document.getElementById('schema-' + index);
      const button = content.previousElementSibling;
      const span = button.querySelector('span');
      
      if (content.classList.contains('active')) {
        content.classList.remove('active');
        span.innerText = 'View Input Schema';
      } else {
        content.classList.add('active');
        span.innerText = 'Hide Input Schema';
      }
    }

    // Client-side filtering of tools
    function filterTools() {
      const query = document.getElementById('search').value.toLowerCase();
      const cards = document.querySelectorAll('.tool-card');
      
      cards.forEach(card => {
        const name = card.getAttribute('data-name');
        const desc = card.getAttribute('data-desc');
        if (name.includes(query) || desc.includes(query)) {
          card.style.display = 'flex';
        } else {
          card.style.display = 'none';
        }
      });
    }
  </script>
</body>
</html>`;
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}
