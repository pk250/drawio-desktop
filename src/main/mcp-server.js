#!/usr/bin/env node
// Draw.io MCP server entry point.
//
// Runs the MCP server either as a plain Node process (dev / headless / tests)
// or inside the Electron main process (packaged app). When the packaged app is
// launched with `--mcp`, electron.js calls runMcpServer directly with the app
// path; when this file is executed on its own, it derives the same config from
// the command line and imports electron (if present) only for the app path.
//
//   node src/main/mcp-server.js --mcp
//   node src/main/mcp-server.js --mcp --mcp-transport http --mcp-port 8890
//   drawio --mcp
//   drawio --mcp --mcp-readonly
//
// Keeps the process alive: stdio transport listens on stdin; HTTP transport
// binds a socket.

import { detectMcpConfig } from './mcp/config.js';
import { runMcpServer } from './mcp/runner.js';

async function main()
{
	const config = detectMcpConfig(process.argv);

	if (!config)
	{
		console.error('usage: drawio --mcp [--mcp-transport stdio|http] [--mcp-port <port>] ' +
			'[--mcp-host <host>] [--mcp-readonly] [--mcp-allow <dir>] [--mcp-autocommit]');
		process.exit(2);
	}

	let appPath = process.cwd();

	if (process.versions && process.versions.electron)
	{
		try
		{
			const { app } = await import('electron');
			appPath = app.getAppPath();
		}
		catch (e)
		{
			// Not inside Electron — fall through to the working directory.
		}
	}

	config.appPath = appPath;

	const { server } = await runMcpServer(config);

	// Keep the event loop alive for stdio; the transport owns stdin.
	process.stdin.resume();

	process.on('SIGINT', () => server.close().then(() => process.exit(0)).catch(() => process.exit(0)));
	process.on('SIGTERM', () => server.close().then(() => process.exit(0)).catch(() => process.exit(0)));
}

main().catch(e =>
{
	console.error('[drawio-mcp] fatal:', e && e.stack ? e.stack : e);
	process.exit(1);
});
