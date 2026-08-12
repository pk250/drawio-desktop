// Unit tests for the PNG IEND repair (src/main/mcp/png-repair.js)
// Run with: npm test
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { repairPng } from '../main/mcp/png-repair.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'png-repair-'));
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('repairPng', () =>
{
	after(() =>
	{
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('appends a missing IEND chunk', () =>
	{
		const p = path.join(tmp, 'truncated.png');
		const body = Buffer.concat([SIGNATURE, Buffer.from([1, 2, 3, 4])]);
		// A truncated file ends with the 4-byte IEND length field.
		fs.writeFileSync(p, Buffer.concat([body, Buffer.alloc(4)]));

		assert.equal(repairPng(p), true);

		const data = fs.readFileSync(p);
		assert.ok(data.subarray(data.length - 12).equals(IEND));
	});

	test('is idempotent on an already-valid PNG', () =>
	{
		const p = path.join(tmp, 'ok.png');
		const valid = Buffer.concat([SIGNATURE, Buffer.from([1, 2, 3, 4]), IEND]);
		fs.writeFileSync(p, valid);

		assert.equal(repairPng(p), false);
		assert.ok(fs.readFileSync(p).equals(valid));
	});

	test('throws for a missing file', () =>
	{
		assert.throws(() => repairPng(path.join(tmp, 'nope.png')), /cannot read PNG/);
	});
});
