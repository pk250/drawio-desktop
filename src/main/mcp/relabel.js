// Label extraction and bulk swap for .drawio diagrams.
//
// Port of the drawio skill's relabel.py. The main use case is language
// variants: extract every non-empty label into an identity JSON map, translate
// the values, apply the map back — geometry, styles and ids untouched, so both
// variants stay pixel-identical except for the text.

import { getPages, getRoot, toArray } from './xml-model.js';

function labelSlots(doc)
{
	const slots = [];

	for (const page of getPages(doc))
	{
		if (page.name)
		{
			slots.push({ set: v => { page.name = v; }, value: page.name });
		}

		const root = getRoot(page);

		if (!root)
		{
			continue;
		}

		for (const cell of toArray(root.mxCell))
		{
			if (cell.value)
			{
				slots.push({ set: v => { cell.value = v; }, value: cell.value });
			}
		}

		for (const wrapper of toArray(root.object))
		{
			if (wrapper.label)
			{
				slots.push({ set: v => { wrapper.label = v; }, value: wrapper.label });
			}

			for (const inner of toArray(wrapper.mxCell))
			{
				if (inner.value)
				{
					slots.push({ set: v => { inner.value = v; }, value: inner.value });
				}
			}
		}
	}

	return slots;
}

export function extractLabels(doc)
{
	const labels = {};

	for (const slot of labelSlots(doc))
	{
		if (!(slot.value in labels))
		{
			labels[slot.value] = slot.value;
		}
	}

	return labels;
}

export function applyLabelMap(doc, mapping)
{
	const matched = [];
	const used = new Set();
	let replaced = 0;

	for (const slot of labelSlots(doc))
	{
		const old = slot.value;

		if (old in mapping)
		{
			slot.set(String(mapping[old]));
			replaced++;
			used.add(old);
			matched.push(old);
		}
	}

	const unused = Object.keys(mapping).filter(k => !used.has(k));

	return { replaced, matched: matched.length, unused };
}
