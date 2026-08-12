// Unit tests for restyle/relabel/presets (src/main/mcp/restyler.js, relabel.js, presets.js)
// Run with: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseDiagram, serializeDiagram, findCell, getStyleKey } from '../main/mcp/xml-model.js';
import { applyRestyle } from '../main/mcp/restyler.js';
import { extractLabels, applyLabelMap } from '../main/mcp/relabel.js';
import { resolvePreset, listPresetNames, builtInPresets } from '../main/mcp/presets.js';

function doc(xml)
{
	return parseDiagram(xml);
}

const SAMPLE = `<mxfile><diagram name="P"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="Login" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="3" value="Home" vertex="1" parent="1"><mxGeometry x="200" y="10" width="80" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

describe('presets', () =>
{
	test('built-in presets exist with palettes', () =>
	{
		const names = listPresetNames();
		assert.deepEqual(names, ['default', 'dark', 'corporate']);
		const dark = builtInPresets().dark;
		assert.ok(dark.palette.primary);
		assert.ok(dark.palette.primary.fillColor);
		assert.ok(dark.palette.primary.strokeColor);
	});

	test('resolvePreset supports a user JSON file', () =>
	{
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-'));
		const p = path.join(dir, 'mine.json');
		fs.writeFileSync(p, JSON.stringify({ palette: { primary: { fillColor: '#111111', strokeColor: '#222222' } } }));

		const preset = resolvePreset(p);
		assert.equal(preset.palette.primary.fillColor, '#111111');
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('resolvePreset throws for unknown presets', () =>
	{
		assert.throws(() => resolvePreset('nope'), /not found/);
	});
});

describe('applyRestyle', () =>
{
	test('applies a preset to vertices with colors', () =>
	{
		const d = doc(SAMPLE.replace('value="Login"', 'value="Login" style="fillColor=#1e90ff;strokeColor=#000080;"'));
		const preset = builtInPresets().dark;
		const { vertices, edges } = applyRestyle(d, preset);
		assert.equal(vertices, 2);
		assert.equal(edges, 0);

		const style = findCell(d, '2').cell.style;
		// The blue-ish fill is remapped to the primary slot of the dark preset.
		assert.ok(style.includes(`fillColor=${preset.palette.primary.fillColor}`));
	});

	test('leaves fillColor=none and routing styles untouched', () =>
	{
		const d = doc(SAMPLE.replace('value="Login"', 'value="Login" style="fillColor=none;strokeColor=#111111;"'));
		applyRestyle(d, builtInPresets().dark);
		const style = findCell(d, '2').cell.style;
		assert.ok(style.includes('fillColor=none'));
	});

	test('applies the font family and extras', () =>
	{
		const d = doc(SAMPLE.replace('value="Login"', 'value="Login" style="fillColor=#dae8fc;strokeColor=#6c8ebf;"'));
		applyRestyle(d, builtInPresets().corporate);
		const style = findCell(d, '2').cell.style;
		assert.ok(style.includes('fontFamily='));
	});
});

describe('relabel', () =>
{
	test('extractLabels returns an identity map', () =>
	{
		const labels = extractLabels(doc(SAMPLE));
		assert.equal(labels['Login'], 'Login');
		assert.equal(labels['Home'], 'Home');
	});

	test('applyLabelMap replaces matching labels only', () =>
	{
		const d = doc(SAMPLE);
		const res = applyLabelMap(d, { Login: '登录', Home: '首页', Missing: 'X' });
		assert.equal(res.replaced, 2);
		assert.deepEqual(res.unused, ['Missing']);
		assert.equal(findCell(d, '2').cell.value, '登录');
		assert.equal(findCell(d, '3').cell.value, '首页');
	});

	test('applyLabelMap with an empty map changes nothing', () =>
	{
		const d = doc(SAMPLE);
		const res = applyLabelMap(d, {});
		assert.equal(res.replaced, 0);
		assert.deepEqual(res.unused, []);
	});
});
