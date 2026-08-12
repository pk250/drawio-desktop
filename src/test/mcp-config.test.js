// Unit tests for the MCP CLI configuration parser (src/main/mcp/config.js)
// Run with: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectMcpConfig } from '../main/mcp/config.js';

describe('detectMcpConfig', () =>
{
	test('returns null without --mcp', () =>
	{
		assert.equal(detectMcpConfig(['node', 'electron.js', '--foo']), null);
	});

	test('defaults to stdio transport', () =>
	{
		const cfg = detectMcpConfig(['--mcp']);
		assert.equal(cfg.transport, 'stdio');
		assert.equal(cfg.host, '127.0.0.1');
		assert.equal(cfg.port, 8890);
		assert.equal(cfg.readOnly, false);
		assert.equal(cfg.autoCommit, false);
		assert.deepEqual(cfg.allowedDirs, []);
	});

	test('parses equals-form flags', () =>
	{
		const cfg = detectMcpConfig(['--mcp', '--mcp-transport=http', '--mcp-port=4000', '--mcp-host=0.0.0.0', '--mcp-readonly', '--mcp-autocommit', '--mcp-allow=/tmp/a']);
		assert.equal(cfg.transport, 'http');
		assert.equal(cfg.port, 4000);
		assert.equal(cfg.host, '0.0.0.0');
		assert.equal(cfg.readOnly, true);
		assert.equal(cfg.autoCommit, true);
		assert.deepEqual(cfg.allowedDirs, ['/tmp/a']);
	});

	test('parses space-separated flag values', () =>
	{
		const cfg = detectMcpConfig(['--mcp', '--mcp-transport', 'http', '--mcp-port', '4500']);
		assert.equal(cfg.transport, 'http');
		assert.equal(cfg.port, 4500);
	});

	test('rejects unknown transports', () =>
	{
		assert.throws(() => detectMcpConfig(['--mcp', '--mcp-transport=websocket']),
			/invalid --mcp-transport/);
	});

	test('supports repeatable --mcp-allow', () =>
	{
		const cfg = detectMcpConfig(['--mcp', '--mcp-allow', '/a', '--mcp-allow=/b']);
		assert.deepEqual(cfg.allowedDirs, ['/a', '/b']);
	});
});
