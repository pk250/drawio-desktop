// MCP server CLI configuration.
//
// Draw.io can act as a Model Context Protocol server. Detected from the
// command line (``--mcp``), both when launched as the packaged desktop app
// and when run as a plain Node process (``node src/main/mcp-server.js``).
//
// Flags (all optional except --mcp):
//   --mcp                 run the MCP server (stdio transport by default)
//   --mcp-transport       stdio (default) | http
//   --mcp-port <port>     HTTP port (default: 8890)
//   --mcp-host <host>     HTTP bind host (default: 127.0.0.1)
//   --mcp-readonly        disable every mutating tool (review / commit too)
//   --mcp-allow <dir>     allow an extra directory for file access (repeatable)
//   --mcp-autocommit      commit staged diagram changes immediately instead of
//                         requiring an explicit commit_changes call
//
// Env overrides:
//   DRAWIO_MCP_DRAWIO_BIN   path to a drawio CLI binary used for export
//   DRAWIO_MCP_EXPORT_TIMEOUT_MS  per-export timeout (default: 120000)
//   DRAWIO_MCP_NO_STAGING    bypass the write-review staging area entirely
//                            (dangerous; every write hits the disk at once)

function flagValue(argv, name)
{
	const prefix = name + '=';

	for (let i = 0; i < argv.length; i++)
	{
		const token = argv[i];

		if (token === name)
		{
			// Space-separated form: --mcp-port 8890. A following bare token
			// that is not itself a flag is treated as the value.
			const next = argv[i + 1];

			if (next != null && !next.startsWith('-'))
			{
				return next;
			}

			return '';
		}

		if (token.startsWith(prefix))
		{
			return token.slice(prefix.length);
		}
	}

	return null;
}

function flagPresent(argv, name)
{
	return argv.includes(name);
}

export function detectMcpConfig(argv)
{
	if (!flagPresent(argv, '--mcp'))
	{
		return null;
	}

	const transportRaw = flagValue(argv, '--mcp-transport') || process.env.DRAWIO_MCP_TRANSPORT || 'stdio';

	if (transportRaw !== 'stdio' && transportRaw !== 'http')
	{
		throw new Error(`invalid --mcp-transport '${transportRaw}' (expected stdio or http)`);
	}

	const allowed = [];

	for (let i = 0; i < argv.length; i++)
	{
		const token = argv[i];

		if (token === '--mcp-allow' && i + 1 < argv.length)
		{
			allowed.push(argv[i + 1]);
			i++;
		}
		else if (token.startsWith('--mcp-allow='))
		{
			allowed.push(token.slice('--mcp-allow='.length));
		}
	}

	return {
		transport: transportRaw,
		host: flagValue(argv, '--mcp-host') || process.env.DRAWIO_MCP_HOST || '127.0.0.1',
		port: parseInt(flagValue(argv, '--mcp-port') || process.env.DRAWIO_MCP_PORT || '8890', 10) || 8890,
		readOnly: flagPresent(argv, '--mcp-readonly') || process.env.DRAWIO_MCP_READONLY === 'true',
		autoCommit: flagPresent(argv, '--mcp-autocommit') || process.env.DRAWIO_MCP_AUTOCOMMIT === 'true',
		noStaging: process.env.DRAWIO_MCP_NO_STAGING === 'true',
		allowedDirs: allowed,
	};
}
