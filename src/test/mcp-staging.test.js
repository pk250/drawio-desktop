// Unit tests for the write-review staging area (src/main/mcp/staging.js)
// Run with: npm test
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StagingArea, hashContent } from '../main/mcp/staging.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-'));

describe('hashContent', () =>
{
	test('is deterministic', () =>
	{
		assert.equal(hashContent('abc'), hashContent('abc'));
	});

	test('differs for different content', () =>
	{
		assert.notEqual(hashContent('abc'), hashContent('abd'));
	});
});

describe('StagingArea', () =>
{
	let area;

	before(() =>
	{
		area = new StagingArea();
	});

	after(() =>
	{
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('starts empty', () =>
	{
		assert.equal(area.count(), 0);
		assert.equal(area.has('/x'), false);
		assert.equal(area.get('/x'), null);
	});

	test('set/get returns the pending slot with op log', () =>
	{
		const slot = area.set('/tmp/f.drawio', '<mxfile/>', [{ op: 'create', summary: 'created' }]);
		assert.equal(area.has('/tmp/f.drawio'), true);
		assert.equal(area.stagedContent('/tmp/f.drawio'), '<mxfile/>');
		assert.equal(slot.ops.length, 1);
		assert.equal(slot.ops[0].summary, 'created');
	});

	test('set appends ops to an existing slot', () =>
	{
		area.set('/tmp/g.drawio', 'v1');
		area.set('/tmp/g.drawio', 'v2', [{ op: 'edit', summary: 'added a vertex' }]);
		const slot = area.get('/tmp/g.drawio');
		assert.equal(slot.staged, 'v2');
		assert.equal(slot.ops.length, 1);
		assert.equal(slot.ops[0].summary, 'added a vertex');
		assert.equal(slot.original, '');
	});

	test('appendOps accumulates operations', () =>
	{
		area.set('/tmp/h.drawio', 'x');
		area.appendOps('/tmp/h.drawio', [{ op: 'edit', summary: 'op A' }]);
		area.appendOps('/tmp/h.drawio', [{ op: 'edit', summary: 'op B' }]);
		assert.deepEqual(area.get('/tmp/h.drawio').ops.map(o => o.summary), ['op A', 'op B']);
	});

	test('remove clears a slot', () =>
	{
		area.set('/tmp/i.drawio', 'x');
		area.remove('/tmp/i.drawio');
		assert.equal(area.has('/tmp/i.drawio'), false);
	});

	test('checkBaseline detects a concurrent on-disk modification', () =>
	{
		const p = path.join(tmp, 'baseline.drawio');
		fs.writeFileSync(p, 'v1');

		area.set(p, 'v2');
		assert.equal(area.checkBaseline(p), null);

		fs.writeFileSync(p, 'v1-changed');
		const err = area.checkBaseline(p);
		assert.match(err, /modified on disk after it was staged/);

		fs.writeFileSync(p, 'v1');
		assert.equal(area.checkBaseline(p), null);
	});

	test('checkBaseline detects a file appearing for a staged "new" file', () =>
	{
		const p = path.join(tmp, 'appears.drawio');
		fs.rmSync(p, { force: true });

		area.set(p, '<mxfile/>');
		assert.equal(area.checkBaseline(p), null);

		fs.writeFileSync(p, '<mxfile/>');
		assert.match(area.checkBaseline(p), /staged changes were created for a new file/);
	});
});
