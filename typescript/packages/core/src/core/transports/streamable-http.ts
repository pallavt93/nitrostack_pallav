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
   */
  sessionTimeout?: number;

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
  private _routesRegistered = false;
  private mcpServerFactory?: McpServerFactory;
  private mcpSessions: Map<string, McpSession> = new Map();

  constructor(options: StreamableHttpTransportOptions = {}) {
    this.options = {
      port: options.port || 3000,
      host: options.host || 'localhost',
      endpoint: options.endpoint || '/mcp',
      enableSessions: options.enableSessions === true, // Default to false for simpler clients
      sessionTimeout: options.sessionTimeout || 30 * 60 * 1000, // 30 minutes
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
        join(__dirname, '../../../src/assets/nitrocloud.png'), // From dist/core/transports -> src/assets
        join(__dirname, '../../../../src/assets/nitrocloud.png'), // From dist/core/transports -> src/assets (alternative)
        join(process.cwd(), 'src/assets/nitrocloud.png'), // User's project
        join(process.cwd(), 'node_modules/nitrostack/src/assets/nitrocloud.png'), // From node_modules
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
    } catch (error) {
      // Logo is optional, continue without it
      this.logoBase64 = undefined;
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
          session = await this.createSession();
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
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => uuidv4(),
      onsessioninitialized: (sid: string) => {
        this.mcpSessions.set(sid, { server, transport });
      },
    });

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
    return { server, transport };
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
    const serverName = this.serverConfig?.name || 'NitroStack MCP Server';
    const serverVersion = this.serverConfig?.version || '1.0.0';
    const serverDescription = this.serverConfig?.description || 'A powerful MCP server built with NitroStack';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${serverName} - MCP Server Documentation</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --nitrocloud-primary: hsl(217, 91%, 60%);
      --nitrocloud-primary-dark: hsl(217, 91%, 50%);
      --nitrocloud-gradient-start: hsl(217, 91%, 60%);
      --nitrocloud-gradient-end: hsl(221, 83%, 53%);
      --background: hsl(0, 0%, 100%);
      --foreground: hsl(222.2, 84%, 4.9%);
      --primary: hsl(221.2, 83.2%, 53.3%);
      --primary-foreground: hsl(210, 40%, 98%);
      --secondary: hsl(210, 40%, 96.1%);
      --muted: hsl(210, 40%, 96.1%);
      --muted-foreground: hsl(215.4, 16.3%, 46.9%);
      --border: hsl(214.3, 31.8%, 91.4%);
      --radius: 0.75rem;
    }
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
      min-height: 100vh;
      padding: 2rem;
      color: var(--foreground);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    
    .container {
      max-width: 1280px;
      margin: 0 auto;
      background: var(--background);
      border-radius: 24px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      overflow: hidden;
    }
    
    .header {
      background: linear-gradient(135deg, var(--nitrocloud-gradient-start) 0%, var(--nitrocloud-gradient-end) 100%);
      color: white;
      padding: 4rem 2rem;
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    
    .header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, transparent 100%);
      pointer-events: none;
    }
    
    .header > * {
      position: relative;
      z-index: 1;
    }
    
    .logo-container {
      margin-bottom: 2rem;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    
    .logo {
      height: 80px;
      width: auto;
      max-width: 200px;
      object-fit: contain;
      filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.3));
      transition: transform 0.3s ease;
    }
    
    .logo:hover {
      transform: scale(1.05);
    }
    
    .header h1 {
      font-size: 3rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      letter-spacing: -0.025em;
    }
    
    .header .version {
      font-size: 1rem;
      opacity: 0.95;
      font-weight: 400;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    
    .header .description {
      margin-top: 1rem;
      font-size: 1.125rem;
      opacity: 0.95;
      font-weight: 400;
      max-width: 600px;
      margin-left: auto;
      margin-right: auto;
    }
    
    .content {
      padding: 3rem 2rem;
    }
    
    .section {
      margin-bottom: 4rem;
    }
    
    .section:last-child {
      margin-bottom: 0;
    }
    
    .section h2 {
      font-size: 2rem;
      font-weight: 700;
      color: var(--foreground);
      margin-bottom: 1.5rem;
      padding-bottom: 0.75rem;
      border-bottom: 3px solid var(--nitrocloud-primary);
      letter-spacing: -0.02em;
    }
    
    .connection-info {
      background: linear-gradient(to right, var(--secondary) 0%, var(--muted) 100%);
      border-left: 4px solid var(--nitrocloud-primary);
      padding: 2rem;
      border-radius: var(--radius);
      margin-bottom: 2rem;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
    }
    
    .connection-info p {
      font-weight: 600;
      color: var(--foreground);
      margin-bottom: 0.75rem;
      font-size: 0.9375rem;
    }
    
    .connection-info code {
      background: hsl(222.2, 84%, 4.9%);
      color: hsl(142, 76%, 36%);
      padding: 1rem 1.25rem;
      border-radius: 8px;
      font-family: 'Monaco', 'Courier New', 'Menlo', monospace;
      display: block;
      margin-top: 0.75rem;
      word-break: break-all;
      font-size: 0.875rem;
      line-height: 1.6;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }
    
    .connection-info .description {
      margin-top: 1rem;
      color: var(--muted-foreground);
      font-size: 0.9375rem;
      line-height: 1.6;
    }
    
    .tools-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1.5rem;
      margin-top: 1.5rem;
    }
    
    .tool-card {
      background: var(--background);
      border: 2px solid var(--border);
      border-radius: var(--radius);
      padding: 1.75rem;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
    }
    
    .tool-card:hover {
      border-color: var(--nitrocloud-primary);
      box-shadow: 0 8px 24px rgba(59, 159, 255, 0.15);
      transform: translateY(-4px);
    }
    
    .tool-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: linear-gradient(90deg, var(--nitrocloud-gradient-start), var(--nitrocloud-gradient-end));
    }
    
    .tool-name {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--foreground);
      margin-bottom: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      letter-spacing: -0.01em;
    }
    
    .tool-name::before {
      content: '⚡';
      font-size: 1.25rem;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));
    }
    
    .tool-description {
      color: var(--muted-foreground);
      margin-bottom: 1rem;
      line-height: 1.625;
      font-size: 0.9375rem;
    }
    
    .tool-schema {
      background: var(--secondary);
      border-radius: 8px;
      padding: 1rem;
      margin-top: 1rem;
      font-size: 0.875rem;
      border: 1px solid var(--border);
    }
    
    .tool-schema summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--nitrocloud-primary);
      margin-bottom: 0.5rem;
      user-select: none;
      transition: color 0.2s;
    }
    
    .tool-schema summary:hover {
      color: var(--nitrocloud-primary-dark);
    }
    
    .tool-schema pre {
      background: hsl(222.2, 84%, 4.9%);
      color: hsl(142, 76%, 36%);
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      margin-top: 0.75rem;
      font-size: 0.8125rem;
      line-height: 1.6;
      font-family: 'Monaco', 'Courier New', 'Menlo', monospace;
    }
    
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 0.375rem 0.75rem;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-top: 0.5rem;
      transition: all 0.2s;
    }
    
    .badge.widget {
      background: linear-gradient(135deg, hsl(271, 81%, 56%) 0%, hsl(271, 81%, 46%) 100%);
      color: white;
      box-shadow: 0 2px 8px rgba(196, 132, 252, 0.3);
    }
    
    .empty-state {
      text-align: center;
      padding: 4rem 2rem;
      color: var(--muted-foreground);
    }
    
    .empty-state svg {
      width: 64px;
      height: 64px;
      margin: 0 auto 1.5rem;
      opacity: 0.5;
      color: var(--muted-foreground);
    }
    
    .empty-state p {
      font-size: 1rem;
      font-weight: 500;
    }
    
    .footer {
      background: linear-gradient(to right, var(--secondary) 0%, var(--muted) 100%);
      padding: 2.5rem 2rem;
      text-align: center;
      color: var(--muted-foreground);
      border-top: 1px solid var(--border);
    }
    
    .footer p {
      font-size: 0.9375rem;
      line-height: 1.6;
    }
    
    .footer a {
      color: var(--nitrocloud-primary);
      text-decoration: none;
      font-weight: 600;
      transition: color 0.2s;
    }
    
    .footer a:hover {
      color: var(--nitrocloud-primary-dark);
      text-decoration: underline;
    }
    
    @media (max-width: 768px) {
      body {
        padding: 1rem;
      }
      
      .header {
        padding: 3rem 1.5rem;
      }
      
      .header h1 {
        font-size: 2.25rem;
      }
      
      .content {
        padding: 2rem 1.5rem;
      }
      
      .section h2 {
        font-size: 1.75rem;
      }
      
      .tools-grid {
        grid-template-columns: 1fr;
      }
      
      .connection-info {
        padding: 1.5rem;
      }
    }
    
    @media (prefers-color-scheme: dark) {
      :root {
        --background: hsl(222.2, 84%, 4.9%);
        --foreground: hsl(210, 40%, 98%);
        --primary: hsl(217, 91%, 60%);
        --secondary: hsl(217.2, 32.6%, 17.5%);
        --muted: hsl(217.2, 32.6%, 17.5%);
        --muted-foreground: hsl(215, 20.2%, 65.1%);
        --border: hsl(217.2, 32.6%, 17.5%);
      }
      
      .connection-info code {
        background: hsl(217.2, 32.6%, 17.5%);
        color: hsl(142, 76%, 56%);
      }
      
      .tool-schema pre {
        background: hsl(217.2, 32.6%, 17.5%);
        color: hsl(142, 76%, 56%);
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${this.logoBase64 ? `
      <div class="logo-container">
        <img src="data:image/png;base64,${this.logoBase64}" alt="NitroCloud Logo" class="logo">
      </div>
      ` : ''}
      <h1>${serverName}</h1>
      <div class="version">v${serverVersion}</div>
      <div class="description">${serverDescription}</div>
    </div>
    
    <div class="content">
      <div class="section">
        <h2>🔌 Connection Information</h2>
        <div class="connection-info">
          <p>MCP Endpoint</p>
          <code>${mcpEndpoint}</code>
          <p class="description">
            Connect to this MCP server using the endpoint above. The server supports Server-Sent Events (SSE) for real-time bidirectional communication following the Model Context Protocol specification.
          </p>
        </div>
      </div>
      
      <div class="section">
        <h2>🛠️ Available Tools</h2>
        ${tools.length > 0 ? `
          <div class="tools-grid">
            ${tools.map(tool => `
              <div class="tool-card">
                <div class="tool-name">${this.escapeHtml(tool.name)}</div>
                <div class="tool-description">${this.escapeHtml(tool.description || 'No description available')}</div>
                ${(tool as any).widget || (tool as any).outputTemplate || tool._meta?.['openai/outputTemplate'] ? `
                  <span class="badge widget">🎨 Has UI Widget</span>
                ` : ''}
                ${tool.inputSchema ? `
                  <details class="tool-schema">
                    <summary>Input Schema</summary>
                    <pre>${this.escapeHtml(JSON.stringify(tool.inputSchema, null, 2))}</pre>
                  </details>
                ` : ''}
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p>No tools are currently registered on this server.</p>
          </div>
        `}
      </div>
    </div>
    
    <div class="footer">
      <p>Built with <a href="https://nitrostack.ai" target="_blank" rel="noopener noreferrer">NitroStack</a> - The TypeScript MCP Framework</p>
      <p style="margin-top: 0.5rem; font-size: 0.875rem;">Model Context Protocol Server</p>
    </div>
  </div>
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
