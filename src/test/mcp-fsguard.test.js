// Unit tests for the MCP filesystem sandbox (src/main/mcp/fsguard.js)
// Run with: npm test
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFsGuard } from '../main/mcp/fsguard.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsguard-'));
const cwd = path.join(tmp, 'work');
fs.mkdirSync(cwd);
fs.mkdirSync(path.join(cwd, 'sub'));
fs.writeFileSync(path.join(cwd, 'sub', 'a.txt'), 'x');

describe('FsGuard', () =>
{
	let guard;

	before(() =>
	{
		guard = createFsGuard(cwd);
	});

	after(() =>
	{
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('allows paths inside the working directory', () =>
	{
		assert.equal(guard.assertAllowed('sub/a.txt'), path.join(cwd, 'sub', 'a.txt'));
		assert.equal(guard.assertAllowed('/' + path.relative('/', path.join(cwd, 'sub'))), path.join(cwd, 'sub'));
	});

	test('rejects paths outside the working directory', () =>
	{
		assert.throws(() => guard.assertAllowed('/etc/passwd'), /path not allowed by the MCP server/);
		assert.throws(() => guard.assertAllowed('/tmp'), /path not allowed by the MCP server/);
	});

	test('rejects empty and non-string paths', () =>
	{
		assert.throws(() => guard.assertAllowed(''), /invalid path/);
		assert.throws(() => guard.assertAllowed(undefined), /invalid path/);
	});

	test('addAllowed grants a new root', () =>
	{
		const extra = path.join(tmp, 'extra');
		fs.mkdirSync(extra);

		assert.throws(() => guard.assertAllowed(extra), /not allowed/);
		guard.addAllowed(extra);
		assert.equal(guard.assertAllowed(extra), extra);
		guard.removeAllowed(extra);
		assert.throws(() => guard.assertAllowed(extra), /not allowed/);
	});

	test('cannot remove the working directory root', () =>
	{
		assert.throws(() => guard.removeAllowed(cwd), /cannot be removed/);
	});

	test('symlink escape is blocked via realpath', () =>
	{
		const link = path.join(cwd, 'escape');
		fs.symlinkSync('/etc', link);
		assert.throws(() => guard.assertAllowed(path.join(link, 'hostname')), /not allowed/);
	});

	test('assertWritable accepts the sandbox dir on a normal filesystem', () =>
	{
		assert.equal(guard.assertWritable('sub'), path.join(cwd, 'sub'));
	});
});
