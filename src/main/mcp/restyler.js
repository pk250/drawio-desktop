// Re-theme an existing .drawio with a style preset (post-processor).
//
// Port of the drawio skill's restyle.py: every vertex fill/stroke is remapped
// to the preset palette by nearest hue (grey/low-saturation -> neutral), the
// preset font is applied to vertices, and extras (fontColor, edgeColor,
// sketch, globalStrokeWidth, background) are layered on. Edge-routing styles
// and shape keywords are left alone, and fillColor=none is structural so it is
// never replaced.

import { getCells, getStyleKey } from './xml-model.js';
import { listPresetNames as listPresets } from './presets.js';

const SLOT_HUES = { primary: 210, success: 120, warning: 50, accent: 30, danger: 0, secondary: 280 };
const SLOT_ORDER = ['primary', 'success', 'warning', 'accent', 'danger', 'neutral', 'secondary'];

function hexToHls(hex)
{
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;

	if (max === min)
	{
		return { h: 0, l, s: 0 };
	}

	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h;

	switch (max)
	{
		case r: h = (g - b) / d + (g < b ? 6 : 0); break;
		case g: h = (b - r) / d + 2; break;
		default: h = (r - g) / d + 4;
	}

	return { h: h * 60, l, s };
}

function hueSlot(hex, palette)
{
	const { h, l, s } = hexToHls(hex);

	let slot;

	if (s < 0.15 || l > 0.97 || l < 0.03)
	{
		slot = 'neutral';
	}
	else
	{
		const deg = ((h % 360) + 360) % 360;
		slot = Object.keys(SLOT_HUES).reduce((best, k) =>
		{
			const d = Math.min(Math.abs(deg - SLOT_HUES[k]), 360 - Math.abs(deg - SLOT_HUES[k]));

			return d < Math.min(Math.abs(deg - SLOT_HUES[best]), 360 - Math.abs(deg - SLOT_HUES[best])) ? k : best;
		}, 'primary');
	}

	if (palette[slot])
	{
		return slot;
	}

	for (const k of SLOT_ORDER)
	{
		if (palette[k])
		{
			return k;
		}
	}

	throw new Error('preset palette has no non-null slots');
}

function setKeys(style, kv)
{
	let out = style;

	for (const key of Object.keys(kv))
	{
		out = out.replace(new RegExp(`(?:^|;)${key}=[^;]*`, 'g'), '').replace(/^;/, '');
	}

	out = out.replace(/;+$/, '').trim();
	const tail = Object.entries(kv)
		.filter(([, v]) => v != null)
		.map(([k, v]) => `${k}=${v}`)
		.join(';');

	return (out ? out + ';' : '') + tail + ';';
}

export function applyRestyle(doc, preset)
{
	const palette = preset.palette;
	const extras = preset.extras || {};
	const font = preset.font || {};
	const vertexExtra = {};

	if (font.fontFamily) vertexExtra.fontFamily = font.fontFamily;
	if (extras.fontColor) vertexExtra.fontColor = extras.fontColor;
	if (extras.sketch) vertexExtra.sketch = '1';

	if (extras.globalStrokeWidth != null && extras.globalStrokeWidth !== 1)
	{
		vertexExtra.strokeWidth = String(extras.globalStrokeWidth);
	}

	const slotMap = {};
	let vertices = 0;
	let edges = 0;

	for (const entry of getCells(doc))
	{
		const { cell } = entry;

		if (cell.edge === '1')
		{
			const kv = {};

			if (extras.edgeColor)
			{
				kv.strokeColor = extras.edgeColor;
				kv.fontColor = extras.edgeColor;
				kv.labelBackgroundColor = 'none';
			}

			if (extras.sketch) kv.sketch = '1';

			if (extras.globalStrokeWidth != null && extras.globalStrokeWidth !== 1)
			{
				kv.strokeWidth = String(extras.globalStrokeWidth);
			}

			if (Object.keys(kv).length > 0)
			{
				cell.style = setKeys(cell.style || '', kv);
				edges++;
			}

			continue;
		}

		if (cell.vertex !== '1')
		{
			continue;
		}

		const kv = { ...vertexExtra };
		const style = cell.style || '';
		const fill = getStyleKey(style, 'fillColor');

		if (fill && /^#[0-9A-Fa-f]{6}$/.test(fill))
		{
			const key = fill.toLowerCase();
			const slot = slotMap[key] || (slotMap[key] = hueSlot(key, palette));
			const pair = palette[slot];

			if (pair)
			{
				kv.fillColor = pair.fillColor;
				kv.strokeColor = pair.strokeColor;
			}
		}
		else if (fill == null)
		{
			delete kv.fontColor;
		}

		cell.style = setKeys(style, kv);
		vertices++;
	}

	if (extras.background)
	{
		for (const page of (doc.mxfile && [].concat(doc.mxfile.diagram || [])))
		{
			if (page.mxGraphModel)
			{
				page.mxGraphModel.background = extras.background;
			}
		}
	}

	return { vertices, edges };
}

export function listPresetNames()
{
	return listPresets();
}
