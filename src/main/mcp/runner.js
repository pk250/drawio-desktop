// MCP server transport layer: stdio (default) and HTTP (Streamable HTTP).
//
// - stdio: the transport MCP clients (Claude Desktop, Cursor, etc.) use to
//   launch a long-lived server process: `drawio --mcp` (or
//   `node src/main/mcp-server.js --mcp`). JSON-RPC flows over stdin/stdout.
//
// - http: `--mcp-transport http --mcp-port <port>` binds an HTTP server that
//   speaks the MCP Streamable HTTP protocol on /mcp. Intended for remote
//   agents; bind to 127.0.0.1 by default and only widen if you trust your LAN.

import crypto from 'crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { createDrawioMcpServer } from './server.js';

function info(config)
{
	return {
		name: 'draw.io',
		version: config.version || '0.0.0',
		transport: config.transport || 'stdio',
		readOnly: !!config.readOnly,
		autoCommit: !!config.autoCommit,
		writeReview: !config.noStaging && !config.autoCommit,
	};
}

export async function runMcpServer(config)
{
	const server = createDrawioMcpServer(config);

	if (config.transport === 'http')
	{
		return startHttpServer(server, config);
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);

	console.error(`[drawio-mcp] ${info(config).name} ${info(config).version} serving over stdio`);

	return { server, transport };
}

function startHttpServer(server, config)
{
	const app = express();
	const sessions = new Map();
	const lastSeen = new Map();

	app.use(express.json({ limit: '20mb' }));
	app.use((req, res, next) =>
	{
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, accept');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		next();
	});

	app.get('/mcp', async (req, res) =>
	{
		const sessionId = req.headers['mcp-session-id'];
		const transport = sessionId ? sessions.get(sessionId) : null;

		if (!transport)
		{
			res.status(404).json({ error: 'unknown MCP session' });
			return;
		}

		lastSeen.set(sessionId, Date.now());
		res.status(200).setHeader('mcp-session-id', sessionId);
		res.status(200).setHeader('Content-Type', 'text/event-stream');
		transport.handleRequest(req, res);
	});

	app.post('/mcp', async (req, res) =>
	{
		const sessionId = req.headers['mcp-session-id'];

		if (!sessionId)
		{
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => crypto.randomUUID(),
				onsessioninitialized: id =>
				{
					sessions.set(id, transport);
					lastSeen.set(id, Date.now());
				},
			});

			await server.connect(transport);
			transport.handleRequest(req, res, req.body);
		}
		else
		{
			const transport = sessions.get(sessionId);

			if (!transport)
			{
				res.status(404).json({ error: 'unknown MCP session' });
				return;
			}

			lastSeen.set(sessionId, Date.now());
			transport.handleRequest(req, res, req.body);
		}
	});

	app.delete('/mcp', async (req, res) =>
	{
		const sessionId = req.headers['mcp-session-id'];

		if (sessionId && sessions.has(sessionId))
		{
			const transport = sessions.get(sessionId);

			sessions.delete(sessionId);
			await transport.close();
			res.status(200).json({ ok: true });
			return;
		}

		res.status(404).json({ error: 'unknown MCP session' });
	});

	const listener = app.listen(config.port, config.host, () =>
	{
		console.error(`[drawio-mcp] HTTP server listening on http://${config.host}:${config.port}/mcp`);
	});

	// Keep sessions from leaking when the client forgets to DELETE.
	setInterval(() =>
	{
		const now = Date.now();

		for (const [id, seen] of lastSeen)
		{
			if (now - seen > 30 * 60 * 1000)
			{
				sessions.delete(id);
				lastSeen.delete(id);
			}
		}
	}, 5 * 60 * 1000).unref();

	return { server, httpServer: listener };
}
