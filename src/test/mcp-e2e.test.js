// End-to-end test of the MCP server over stdio, exercising the full
// write-review lifecycle: stage -> validate -> review -> commit.
// Run with: npm test
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'));

describe('MCP server (stdio, write-review)', () =>
{
	let client;
	let transport;
	const out = path.join(tmp, 'demo.drawio');

	before(async () =>
	{
		transport = new StdioClientTransport({
			command: process.execPath,
			args: [path.join(root, 'src', 'main', 'mcp-server.js'), '--mcp'],
			cwd: tmp,
		});
		client = new Client({ name: 'e2e-test', version: '1.0.0' });
		await client.connect(transport);
	});

	after(async () =>
	{
		try
		{
			await client.close();
		}
		catch (e)
		{
			// server may already be gone
		}

		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('lists 22 tools including the write-review trio', async () =>
	{
		const { tools } = await client.listTools();
		const names = tools.map(t => t.name);
		assert.equal(tools.length, 22);
		assert.ok(names.includes('create_diagram'));
		assert.ok(names.includes('edit_diagram'));
		assert.ok(names.includes('review_pending_changes'));
		assert.ok(names.includes('commit_changes'));
		assert.ok(names.includes('discard_changes'));
		assert.ok(names.includes('validate_diagram'));
	});

	test('session_info reports write-review defaults', async () =>
	{
		const res = await client.callTool({ name: 'session_info', arguments: {} });
		const m = res.structuredContent.mode;
		assert.equal(m.writeReview, true);
		assert.equal(m.readOnly, false);
		assert.equal(m.autoCommit, false);
	});

	test('write-review flow: create -> edit -> validate -> review -> commit', async () =>
	{
		const created = await client.callTool({ name: 'create_diagram', arguments: { path: out, pages: ['Main'] } });
		assert.ok(!created.isError, "created should succeed");
		assert.equal(fs.existsSync(out), false, 'nothing should hit the disk before commit');

		const edited = await client.callTool({
			name: 'edit_diagram',
			arguments: {
				path: out,
				ops: [
					{ op: 'addVertex', value: 'Login', x: 120, y: 80, width: 120, height: 60 },
					{ op: 'addVertex', id: 'svc', value: 'Auth Service', x: 420, y: 200, width: 140, height: 70 },
					{ op: 'addEdge', source: '2', target: 'svc', label: 'token' },
				],
			},
		});
		assert.ok(!edited.isError, "edited should succeed");

		const valid = await client.callTool({ name: 'validate_diagram', arguments: { path: out } });
		assert.equal(valid.structuredContent.ok, true);
		assert.equal(valid.structuredContent.source, 'staged');

		const review = await client.callTool({ name: 'review_pending_changes', arguments: { path: out } });
		assert.equal(review.structuredContent.pending.length, 1);
		assert.equal(review.structuredContent.pending[0].ops.length, 4);

		const committed = await client.callTool({ name: 'commit_changes', arguments: { path: out } });
		assert.ok(!committed.isError, "committed should succeed");
		assert.equal(fs.existsSync(out), true, 'commit must write the file to disk');

		const info = await client.callTool({ name: 'get_diagram_info', arguments: { path: out, includeCells: true } });
		assert.equal(info.structuredContent.source, 'disk');
		assert.equal(info.structuredContent.pending, false);
		assert.equal(info.structuredContent.vertexCount, 2);
		assert.equal(info.structuredContent.edgeCount, 1);
	});

	test('discard_changes drops a pending edit without touching disk', async () =>
	{
		const p = path.join(tmp, 'discard.drawio');
		await client.callTool({ name: 'create_diagram', arguments: { path: p, overwrite: true } });
		await client.callTool({ name: 'edit_diagram', arguments: { path: p, ops: [{ op: 'addVertex', value: 'X' }] } });

		const disc = await client.callTool({ name: 'discard_changes', arguments: { path: p } });
		assert.ok(!disc.isError, "disc should succeed");

		assert.equal(fs.existsSync(p), false, 'the staged file must never hit the disk');

		const info = await client.callTool({ name: 'get_diagram_info', arguments: { path: p } });
		assert.equal(info.isError, true, 'file no longer exists after discard');
	});

	test('a dangling edge blocks commit until forced', async () =>
	{
		const p = path.join(tmp, 'dangling.drawio');
		await client.callTool({ name: 'create_diagram', arguments: { path: p, overwrite: true } });
		await client.callTool({ name: 'edit_diagram', arguments: { path: p, ops: [
			{ op: 'addVertex', value: 'A' },
		] } });

		// Patch a bad edge directly into the staged content via a second edit
		// is not possible (addEdge validates), so force one with removeCell then
		// re-add the dangling endpoint through the relabel path is also blocked.
		// Instead craft a file with a dangling edge and stage it.
		const d = path.join(tmp, 'dangling2.drawio');
		const xml = `<mxfile><diagram name="P"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="3" edge="1" parent="1" source="2" target="nope"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;
		await client.callTool({ name: 'create_diagram', arguments: { path: d, overwrite: true, initialXml: xml } });

		const valid = await client.callTool({ name: 'validate_diagram', arguments: { path: d } });
		assert.equal(valid.structuredContent.ok, false);
		assert.ok(valid.structuredContent.errors.some(e => e.includes('target')));

		const commit = await client.callTool({ name: 'commit_changes', arguments: { path: d } });
		assert.equal(commit.isError, true, 'commit must refuse an invalid diagram');
		assert.match(commit.content[0].text, /fail|validation|invalid/i);

		const forced = await client.callTool({ name: 'commit_changes', arguments: { path: d, force: true } });
		assert.ok(!forced.isError, "forced should succeed");
	});

	test('paths outside the sandbox are rejected', async () =>
	{
		const res = await client.callTool({ name: 'read_diagram', arguments: { path: '/etc/passwd' } });
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /path not allowed by the MCP server/);
	});

	test('unknown tools and bad arguments return errors, not crashes', async () =>
	{
		const res = await client.callTool({ name: 'edit_diagram', arguments: { path: path.join(tmp, 'nope.drawio'), ops: [{ op: 'bogus' }] } });
		assert.equal(res.isError, true);
	});
});
