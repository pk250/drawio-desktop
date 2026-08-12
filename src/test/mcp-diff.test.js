// Unit tests for the diagram diff (src/main/mcp/diff.js)
// Run with: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiagram } from '../main/mcp/xml-model.js';
import { diffDocuments } from '../main/mcp/diff.js';

function doc(xml)
{
	return parseDiagram(xml);
}

const A = `<mxfile><diagram name="P"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="3" value="B" vertex="1" parent="1"><mxGeometry x="200" y="10" width="80" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

const B = `<mxfile><diagram name="P"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="3" value="B renamed" vertex="1" parent="1"><mxGeometry x="200" y="10" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="4" value="C" vertex="1" parent="1"><mxGeometry x="400" y="10" width="80" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

describe('diffDocuments', () =>
{
	test('ignores the root scaffolding cells 0/1', () =>
	{
		const d = diffDocuments(doc(A), doc(A));
		assert.deepEqual(d.added, []);
		assert.deepEqual(d.removed, []);
		assert.equal(d.same, 2);
	});

	test('detects added and removed cells', () =>
	{
		const d = diffDocuments(doc(A), doc(B));
		assert.deepEqual(d.added.map(a => a.id), ['4']);
		assert.deepEqual(d.removed, []);
	});

	test('detects label changes', () =>
	{
		const d = diffDocuments(doc(A), doc(B));
		const changed = d.changed.find(c => c.id === '3');
		assert.equal(changed.kind, 'vertex');
		assert.ok(changed.changes.some(c => c.includes('label:')));
	});

	test('byLabel matches cells by their label instead of id', () =>
	{
		const renamedId = `<mxfile><diagram name="P"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="99" value="B" vertex="1" parent="1"><mxGeometry x="200" y="10" width="80" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;
		const d = diffDocuments(doc(A), doc(renamedId), { byLabel: true });
		assert.equal(d.added.length, 0);
		assert.equal(d.removed.length, 0);
	});
});
