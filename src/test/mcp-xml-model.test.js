// Unit tests for the .drawio XML model (src/main/mcp/xml-model.js)
// Run with: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseDiagram, serializeDiagram, getPages, getPage, getCells, findCell,
	nextId, addVertex, addEdge, removeCell, addPage, removePage, renamePage,
	getStyleKey, setStyleKeys, cellInfo, diagramSummary,
} from '../main/mcp/xml-model.js';

const SAMPLE = `<mxfile host="app" type="device">
  <diagram id="d1" name="P1">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="2" value="Login" vertex="1" parent="1">
          <mxGeometry x="120" y="80" width="120" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="3" edge="1" parent="1" source="2" target="2">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

describe('parseDiagram / serializeDiagram', () =>
{
	test('round-trips a simple file preserving attributes', () =>
	{
		const doc = parseDiagram(SAMPLE);
		const xml = serializeDiagram(doc);

		assert.match(xml, /host="app"/);
		assert.match(xml, /id="d1" name="P1"/);
		assert.match(xml, /value="Login"/);
		assert.match(xml, /vertex="1"/);
	});

	test('rejects malformed XML', () =>
	{
		assert.throws(() => parseDiagram('<mxfile><diagram'), /Error/);
	});

	test('escapes special characters in values', () =>
	{
		const doc = parseDiagram(SAMPLE);
		const cell = findCell(doc, '2').cell;
		setStyleKeys(cell.style || '', {});
		cell.value = 'A & B < C > "D" \'E\'';
		const xml = serializeDiagram(doc);

		assert.match(xml, /value="A &amp; B &lt; C &gt; &quot;D&quot; &apos;E&apos;"/);
	});

	test('serializes a lone diagram without an explicit array', () =>
	{
		const doc = parseDiagram(SAMPLE.replace('<diagram', '<diagram'));
		assert.equal(getPages(doc).length, 1);
	});
});

describe('page management', () =>
{
	test('getPages / getPage', () =>
	{
		const doc = parseDiagram(SAMPLE);
		assert.deepEqual(getPages(doc).map(p => p.name), ['P1']);
		assert.equal(getPage(doc, 'P1').name, 'P1');
		assert.equal(getPage(doc, 'missing'), null);
	});

	test('addPage and removePage', () =>
	{
		const doc = parseDiagram(SAMPLE);
		addPage(doc, 'P2');
		assert.deepEqual(getPages(doc).map(p => p.name), ['P1', 'P2']);
		removePage(doc, 'P2');
		assert.deepEqual(getPages(doc).map(p => p.name), ['P1']);
		assert.throws(() => addPage(doc, 'P1'), /already exists/);
		assert.throws(() => removePage(doc, 'nope'), /does not exist/);
	});

	test('renamePage', () =>
	{
		const doc = parseDiagram(SAMPLE);
		renamePage(doc, 'P1', '首页');
		assert.deepEqual(getPages(doc).map(p => p.name), ['首页']);
		assert.throws(() => renamePage(doc, 'missing', 'x'), /does not exist/);
	});
});

describe('cell operations', () =>
{
	test('nextId skips existing ids', () =>
	{
		const doc = parseDiagram(SAMPLE);
		assert.equal(nextId(doc), '4');
	});

	test('addVertex creates a geometry and increments ids', () =>
	{
		const doc = parseDiagram(SAMPLE);
		const res = addVertex(doc, { value: 'B', x: 5, y: 6, width: 100, height: 40 });
		assert.equal(res.id, '4');
		const cell = findCell(doc, '4').cell;
		assert.equal(cell.vertex, '1');
		assert.equal(cell.mxGeometry.x, '5');
		assert.equal(cell.mxGeometry.height, '40');
	});

	test('addEdge rejects dangling references', () =>
	{
		const doc = parseDiagram(SAMPLE);
		assert.throws(() => addEdge(doc, { source: '2', target: 'ghost' }), /references missing cell 'ghost'/);
	});

	test('addEdge stores waypoints', () =>
	{
		const doc = parseDiagram(SAMPLE);
		const res = addEdge(doc, { source: '2', target: '2', waypoints: [{ x: 50, y: 50 }] });
		const cell = findCell(doc, res.id).cell;
		assert.equal(cell.mxGeometry.Array[0].mxPoint[0].x, '50');
	});

	test('removeCell cascades to referencing edges', () =>
	{
		const doc = parseDiagram(SAMPLE);
		removeCell(doc, '2');
		assert.equal(findCell(doc, '2'), null);
		assert.equal(findCell(doc, '3'), null);
		assert.throws(() => removeCell(doc, '2'), /does not exist/);
	});
});

describe('styles', () =>
{
	test('getStyleKey extracts a key from a style string', () =>
	{
		assert.equal(getStyleKey('rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;', 'fillColor'), '#dae8fc');
		assert.equal(getStyleKey('rounded=1;fillColor=#dae8fc;', 'nope'), null);
	});

	test('setStyleKeys preserves unrelated keys', () =>
	{
		assert.equal(
			setStyleKeys('rounded=1;fillColor=#dae8fc;', { fillColor: '#fff2cc', strokeWidth: '3' }),
			'rounded=1;fillColor=#fff2cc;strokeWidth=3;');
	});

	test('setStyleKeys removes a key when value is null', () =>
	{
		assert.equal(setStyleKeys('fillColor=#dae8fc;fontColor=#333;', { fillColor: null }),
			'fontColor=#333;');
	});
});

describe('analysis helpers', () =>
{
	test('cellInfo reports shape kind', () =>
	{
		const doc = parseDiagram(SAMPLE);
		const v = cellInfo(findCell(doc, '2'));
		assert.equal(v.vertex, true);
		assert.equal(v.edge, false);
		const e = cellInfo(findCell(doc, '3'));
		assert.equal(e.edge, true);
	});

	test('diagramSummary counts vertices, edges and pages', () =>
	{
		const doc = parseDiagram(SAMPLE);
		const sum = diagramSummary(doc);
		assert.equal(sum.vertexCount, 1);
		assert.equal(sum.edgeCount, 1);
		assert.equal(sum.pages.length, 1);
	});
});
