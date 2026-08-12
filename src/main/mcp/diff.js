// Structural diff between two .drawio documents.
//
// Used by the write-review flow to answer "what changed?" between the staged
// content and the file on disk, and by diff_diagrams for arbitrary file pairs.
//
// Vertices/edges are matched by cell id (stable for generated diagrams) or, in
// --by-label mode, by visible label (hand-drawn diagrams). The report lists
// added / removed / changed cells with a human-readable change description and
// page-level changes.

import { getCells, cellId, getCellValue, getGeometry, parseDiagram } from './xml-model.js';

const INSPECT_KEYS = ['value', 'style', 'vertex', 'edge', 'parent', 'source', 'target'];

function keyOf(entry, byLabel)
{
	if (byLabel)
	{
		return getCellValue(entry);
	}

	return cellId(entry);
}

function describeChange(oldEntry, newEntry)
{
	const out = [];

	if (getCellValue(oldEntry) !== getCellValue(newEntry))
	{
		out.push(`label: '${oldEntry.cell.value ?? ''}' -> '${newEntry.cell.value ?? ''}'`);
	}

	if ((oldEntry.cell.style || '') !== (newEntry.cell.style || ''))
	{
		out.push('style changed');
	}

	for (const key of ['source', 'target', 'vertex', 'edge', 'parent'])
	{
		if ((oldEntry.cell[key] ?? null) !== (newEntry.cell[key] ?? null))
		{
			out.push(`${key}: ${oldEntry.cell[key] ?? '-'} -> ${newEntry.cell[key] ?? '-'}`);
		}
	}

	const go = getGeometry(oldEntry.cell);
	const gn = getGeometry(newEntry.cell);

	if (go && gn)
	{
		const diffs = [];

		for (const k of ['x', 'y', 'width', 'height'])
		{
			if (Math.round(go[k] * 100) !== Math.round(gn[k] * 100))
			{
				diffs.push(`${k}: ${go[k]} -> ${gn[k]}`);
			}
		}

		if (diffs.length > 0)
		{
			out.push(`geometry: ${diffs.join(', ')}`);
		}
	}

	return out;
}

export function diffDocuments(oldDoc, newDoc, { byLabel = false } = {})
{
	// Root scaffolding cells (ids 0/1) are present in every file and add noise.
	const isRoot = entry => entry.cell.id === '0' || entry.cell.id === '1';

	const oldEntries = getCells(oldDoc).filter(e => !isRoot(e));
	const newEntries = getCells(newDoc).filter(e => !isRoot(e));
	const oldByKey = new Map(oldEntries.map(e => [keyOf(e, byLabel), e]));
	const newByKey = new Map(newEntries.map(e => [keyOf(e, byLabel), e]));

	const added = [];
	const removed = [];
	const changed = [];
	let same = 0;

	for (const [key, entry] of newByKey)
	{
		if (!oldByKey.has(key))
		{
			added.push(entryToSummary(entry));
		}
	}

	for (const [key, entry] of oldByKey)
	{
		if (!newByKey.has(key))
		{
			removed.push(entryToSummary(entry));
		}
	}

	for (const [key, oldEntry] of oldByKey)
	{
		const newEntry = newByKey.get(key);

		if (!newEntry) continue;

		const changes = describeChange(oldEntry, newEntry);

		if (changes.length > 0)
		{
			changed.push({ id: cellId(newEntry), kind: newEntry.cell.edge === '1' ? 'edge' : 'vertex', changes });
		}
		else
		{
			same++;
		}
	}

	return { byLabel, added, removed, changed, same };
}

function entryToSummary(entry)
{
	return {
		id: cellId(entry),
		kind: entry.cell.edge === '1' ? 'edge' : (entry.cell.vertex === '1' ? 'vertex' : 'cell'),
		value: getCellValue(entry),
		style: entry.cell.style || '',
	};
}

export function diffTexts(oldText, newText, opts)
{
	const oldDoc = parseDiagram(oldText);
	const newDoc = parseDiagram(newText);

	return diffDocuments(oldDoc, newDoc, opts);
}

export function formatDiffReport(diff)
{
	const lines = [];

	if (diff.added.length > 0)
	{
		lines.push(`added (${diff.added.length}): ${diff.added.map(c => c.id).join(', ')}`);
	}

	if (diff.removed.length > 0)
	{
		lines.push(`removed (${diff.removed.length}): ${diff.removed.map(c => c.id).join(', ')}`);
	}

	for (const c of diff.changed)
	{
		lines.push(`changed ${c.id}: ${c.changes.join('; ')}`);
	}

	if (diff.same > 0)
	{
		lines.push(`unchanged: ${diff.same}`);
	}

	return lines.join('\n');
}
