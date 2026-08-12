// Unit tests for the deterministic structural linter (src/main/mcp/validator.js)
// Run with: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiagram } from '../main/mcp/xml-model.js';
import { validate } from '../main/mcp/validator.js';

function doc(xml)
{
	return parseDiagram(xml);
}

const BASE = `<mxfile><diagram name="P"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

describe('validate', () =>
{
	test('passes a clean diagram', () =>
	{
		const r = validate(doc(BASE));
		assert.equal(r.ok, true);
		assert.deepEqual(r.errors, []);
		assert.deepEqual(r.warnings, []);
		assert.equal(r.score, 0);
	});

	test('flags a dangling edge target', () =>
	{
		const xml = BASE.replace('</root>',
			'<mxCell id="3" edge="1" parent="1" source="2" target="nope"><mxGeometry relative="1" as="geometry"/></mxCell></root>');
		const r = validate(doc(xml));
		assert.equal(r.ok, false);
		assert.deepEqual(r.errors, ["edge '3' target 'nope' does not exist"]);
	});

	test('flags a dangling parent reference', () =>
	{
		const xml = BASE.replace('</root>',
			'<mxCell id="3" value="x" vertex="1" parent="99"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root>');
		const r = validate(doc(xml));
		assert.ok(r.errors.some(e => e.includes("parent '99' does not exist")));
	});

	test('flags duplicate and reserved ids', () =>
	{
		const xml = BASE.replace('</root>',
			'<mxCell id="2" value="B" vertex="1" parent="1"><mxGeometry x="200" y="10" width="80" height="40" as="geometry"/></mxCell></root>');
		const r = validate(doc(xml));
		assert.ok(r.errors.includes("duplicate id '2'"));

		const reserved = BASE.replace('</root>',
			'<mxCell id="1" value="B" vertex="1" parent="1"><mxGeometry x="200" y="10" width="80" height="40" as="geometry"/></mxCell></root>');
		const r2 = validate(doc(reserved));
		assert.ok(r2.errors.some(e => e.includes('reuses reserved id 0/1')));
	});

	test('warns on overlapping siblings', () =>
	{
		const xml = BASE.replace('</root>',
			'<mxCell id="3" value="B" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell></root>');
		const r = validate(doc(xml));
		assert.ok(r.warnings.some(w => w.includes("overlap")));
	});

	test('warns on non-positive sizes and negative positions', () =>
	{
		const xml = BASE.replace('<mxGeometry x="10" y="10" width="80" height="40" as="geometry"/>',
			'<mxGeometry x="-5" y="10" width="0" height="40" as="geometry"/>');
		const r = validate(doc(xml));
		assert.ok(r.warnings.some(w => w.includes('non-positive size')));
		assert.ok(r.warnings.some(w => w.includes('negative position')));
	});

	test('strict mode requires zero warnings', () =>
	{
		assert.equal(validate(doc(BASE), { strict: true }).ok, true);
	});

	test('compressed pages are skipped, not failed', () =>
	{
		const xml = `<mxfile><diagram name="P">U2FsdGVkX1</diagram></mxfile>`;
		const r = validate(doc(xml));
		assert.equal(r.ok, true);
		assert.ok(r.warnings.some(w => w.includes('compressed')));
	});
});
