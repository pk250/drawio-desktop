// Minimal .drawio XML model built on fast-xml-parser.
//
// A .drawio file is an <mxfile> root containing one <diagram> per page; each
// page holds an <mxGraphModel> whose <root> lists <mxCell> elements (vertices
// and edges) and optional <object>/<UserObject> wrappers (links, metadata).
// Cells are identified by id across the whole file.
//
// This module parses such files into plain JSON, exposes query helpers, and
// provides targeted edit operations that mutate the JSON in place. The JSON is
// re-serialised with fast-xml-parser, so entity escaping and structure are
// handled for us. Whitespace between tags is preserved so untouched pages stay
// byte-stable after a targeted edit.

import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const PARSER_OPTIONS = {
	ignoreAttributes: false,
	attributeNamePrefix: '',
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: false,
	processEntities: true,
	isArray: (name) => ['diagram', 'mxCell', 'mxPoint', 'Array'].includes(name),
};

const BUILDER_OPTIONS = {
	...PARSER_OPTIONS,
	suppressEmptyNode: true,
	format: false,
};

export function parseDiagram(text)
{
	const parser = new XMLParser(PARSER_OPTIONS);

	return parser.parse(text);
}

export function serializeDiagram(doc)
{
	const builder = new XMLBuilder(BUILDER_OPTIONS);

	return builder.build(doc);
}

export function toArray(x)
{
	if (x == null) return [];
	if (Array.isArray(x)) return x;

	return [x];
}

// --- Page / cell access ---------------------------------------------------

export function getPages(doc)
{
	return toArray(doc.mxfile && doc.mxfile.diagram);
}

export function getPage(doc, page)
{
	if (page == null)
	{
		return getPages(doc)[0] || null;
	}

	const pages = getPages(doc);

	if (typeof page === 'string')
	{
		return pages.find(p => p.name === page) || null;
	}

	const idx = typeof page === 'number' ? page : parseInt(page, 10) - 1;

	return pages[idx] || null;
}

export function getRoot(page)
{
	if (!page) return null;

	const model = page.mxGraphModel;

	return (model && model.root) || null;
}

export function getCells(doc)
{
	// Every cell (mxCell, and object/UserObject-wrapped mxCell) across pages.
	const out = [];

	for (const page of getPages(doc))
	{
		const root = getRoot(page);

		if (!root) continue;

		for (const child of toArray(root.mxCell))
		{
			out.push({ page, cell: child, wrapper: null });
		}

		for (const wrapper of toArray(root.object))
		{
			for (const inner of toArray(wrapper.mxCell))
			{
				out.push({ page, cell: inner, wrapper });
			}
		}
	}

	return out;
}

// Effective id of a cell entry: the wrapper id when wrapped, else the cell id.
export function cellId(entry)
{
	return entry.wrapper ? entry.wrapper.id : entry.cell.id;
}

export function findCell(doc, id)
{
	for (const entry of getCells(doc))
	{
		if (cellId(entry) === String(id))
		{
			return entry;
		}
	}

	return null;
}

export function getCellValue(entry)
{
	if (entry.wrapper)
	{
		return entry.wrapper.label ?? entry.cell.value ?? '';
	}

	return entry.cell.value ?? '';
}

export function setCellValue(entry, value)
{
	if (entry.wrapper)
	{
		entry.wrapper.label = value;
		entry.cell.value = value;
	}
	else
	{
		entry.cell.value = value;
	}
}

export function getGeometry(cell)
{
	const g = cell.mxGeometry;

	if (!g) return null;

	return {
		x: g.x != null ? parseFloat(g.x) : 0,
		y: g.y != null ? parseFloat(g.y) : 0,
		width: g.width != null ? parseFloat(g.width) : NaN,
		height: g.height != null ? parseFloat(g.height) : NaN,
		relative: g.relative === '1',
	};
}

export function setGeometry(cell, { x, y, width, height })
{
	if (!cell.mxGeometry)
	{
		cell.mxGeometry = { as: 'geometry' };
	}

	if (x != null) cell.mxGeometry.x = String(x);
	if (y != null) cell.mxGeometry.y = String(y);
	if (width != null) cell.mxGeometry.width = String(width);
	if (height != null) cell.mxGeometry.height = String(height);
}

export function getWaypoints(cell)
{
	const arr = cell.mxGeometry && toArray(cell.mxGeometry.Array).find(a => a.as === 'points');

	if (!arr) return [];

	return toArray(arr.mxPoint).map(pt => ({ x: parseFloat(pt.x), y: parseFloat(pt.y) }));
}

export function setWaypoints(cell, points)
{
	if (!cell.mxGeometry)
	{
		cell.mxGeometry = { as: 'geometry' };
	}

	if (points.length === 0)
	{
		cell.mxGeometry.Array = [];
		return;
	}

	cell.mxGeometry.Array = [{
		as: 'points',
		mxPoint: points.map(pt => ({ x: String(pt.x), y: String(pt.y) })),
	}];
}

// --- Style helpers ---------------------------------------------------------

export function getStyle(cell)
{
	return cell.style || '';
}

export function getStyleKey(style, key)
{
	for (const part of style.split(';'))
	{
		if (part.startsWith(key + '='))
		{
			return part.slice(key.length + 1);
		}
	}

	return null;
}

export function setStyleKeys(style, kv)
{
	let out = style;

	for (const key of Object.keys(kv))
	{
		const re = new RegExp(`(?:^|;)${key}=[^;]*`, 'g');
		out = out.replace(re, '').replace(/^;/, '');
	}

	const tail = Object.entries(kv)
		.filter(([, v]) => v != null)
		.map(([k, v]) => `${k}=${v}`)
		.join(';');

	out = out.replace(/;+$/, '').trim();

	if (!tail)
	{
		return out.endsWith(';') ? out : out + ';';
	}

	return (out ? out + ';' : '') + tail + ';';
}

// --- Page helpers ----------------------------------------------------------

export function nextId(doc)
{
	let max = 1;

	for (const entry of getCells(doc))
	{
		const id = parseInt(cellId(entry), 10);

		if (!isNaN(id) && id > max) max = id;
	}

	return String(max + 1);
}

// --- Write operations (mutate the parsed doc in place) ----------------------

export function addVertex(doc, { page, id, parent, value, style, x, y, width, height })
{
	const p = getPage(doc, page) || getPage(doc);

	if (!p)
	{
		throw new Error('no diagram page available to add a vertex to');
	}

	if (!getRoot(p))
	{
		throw new Error(`page '${p.name || '?'}' is compressed; open and save it in draw.io first`);
	}

	const cell = {
		id: id || nextId(doc),
		value: value ?? '',
		style: style || '',
		vertex: '1',
		parent: parent || '1',
		mxGeometry: {
			x: String(x ?? 0),
			y: String(y ?? 0),
			width: String(width ?? 120),
			height: String(height ?? 60),
			as: 'geometry',
		},
	};

	getRoot(p).mxCell.push(cell);

	return { page: p.name, id: cell.id };
}

export function addEdge(doc, { page, id, parent, source, target, label, style, waypoints })
{
	const p = getPage(doc, page) || getPage(doc);

	if (!p)
	{
		throw new Error('no diagram page available to add an edge to');
	}

	if (!getRoot(p))
	{
		throw new Error(`page '${p.name || '?'}' is compressed; open and save it in draw.io first`);
	}

	for (const [attr, ref] of [['source', source], ['target', target]])
	{
		if (ref != null && !findCell(doc, ref))
		{
			throw new Error(`edge ${attr} references missing cell '${ref}'`);
		}
	}

	const cell = {
		id: id || nextId(doc),
		style: style || '',
		edge: '1',
		parent: parent || '1',
	};

	if (source != null) cell.source = String(source);
	if (target != null) cell.target = String(target);
	if (label != null) cell.value = label;

	cell.mxGeometry = { as: 'geometry', relative: '1' };

	if (waypoints && waypoints.length > 0)
	{
		cell.mxGeometry.Array = [{
			as: 'points',
			mxPoint: waypoints.map(pt => ({ x: String(pt.x), y: String(pt.y) })),
		}];
	}

	getRoot(p).mxCell.push(cell);

	return { page: p.name, id: cell.id };
}

export function removeCell(doc, id)
{
	const entry = findCell(doc, id);

	if (!entry)
	{
		throw new Error(`cell '${id}' does not exist`);
	}

	const { page, cell, wrapper } = entry;
	const root = getRoot(page);

	if (wrapper)
	{
		const list = toArray(root.object);
		const idx = list.indexOf(wrapper);

		if (idx >= 0) list.splice(idx, 1);
		root.object = list;
	}
	else
	{
		const list = toArray(root.mxCell);
		const idx = list.indexOf(cell);

		if (idx >= 0) list.splice(idx, 1);
		root.mxCell = list;
	}

	// Drop edges that referenced the removed cell.
	for (const e of getCells(doc))
	{
		if (e.cell.edge === '1' && (e.cell.source === String(id) || e.cell.target === String(id)))
		{
			removeCell(doc, cellId(e));
		}
	}

	return { removed: String(id) };
}

export function renamePage(doc, name, newName)
{
	const page = getPage(doc, name);

	if (!page)
	{
		throw new Error(`page '${name}' does not exist`);
	}

	page.name = newName;

	return { from: name, to: newName };
}

export function addPage(doc, name)
{
	const pages = getPages(doc);

	if (pages.some(p => p.name === name))
	{
		throw new Error(`page '${name}' already exists`);
	}

	const page = {
		id: `page-${Date.now()}`,
		name,
		mxGraphModel: {
			dx: '0',
			dy: '0',
			grid: '1',
			gridSize: '10',
			guides: '1',
			tooltips: '1',
			connect: '1',
			arrows: '1',
			fold: '1',
			page: '1',
			pageScale: '1',
			pageWidth: '850',
			pageHeight: '1100',
			math: '0',
			shadow: '0',
			root: { mxCell: [
				{ id: '0' },
				{ id: '1', parent: '0' },
			] },
		},
	};

	if (doc.mxfile.diagram == null)
	{
		doc.mxfile.diagram = [page];
	}
	else if (Array.isArray(doc.mxfile.diagram))
	{
		doc.mxfile.diagram.push(page);
	}
	else
	{
		doc.mxfile.diagram = [doc.mxfile.diagram, page];
	}

	return { name };
}

export function removePage(doc, name)
{
	const pages = getPages(doc);
	const idx = pages.findIndex(p => p.name === name);

	if (idx < 0)
	{
		throw new Error(`page '${name}' does not exist`);
	}

	pages.splice(idx, 1);
	doc.mxfile.diagram = pages.length === 1 ? pages[0] : pages;

	return { removed: name };
}

// --- Analysis ---------------------------------------------------------------

export function cellInfo(entry)
{
	const cell = entry.cell;
	const g = getGeometry(cell);
	const isVertex = cell.vertex === '1';
	const isEdge = cell.edge === '1';

	return {
		id: cellId(entry),
		value: getCellValue(entry),
		style: cell.style || '',
		vertex: isVertex,
		edge: isEdge,
		parent: cell.parent ?? null,
		source: isEdge ? cell.source ?? null : null,
		target: isEdge ? cell.target ?? null : null,
		x: g ? g.x : null,
		y: g ? g.y : null,
		width: g && !isNaN(g.width) ? g.width : null,
		height: g && !isNaN(g.height) ? g.height : null,
		waypoints: isEdge ? getWaypoints(cell) : undefined,
		page: entry.page.name ?? null,
	};
}

export function diagramSummary(doc)
{
	const pages = [];
	let vertexCount = 0;
	let edgeCount = 0;

	for (const page of getPages(doc))
	{
		const v = [];
		const e = [];

		for (const entry of getCells(doc))
		{
			if (entry.page !== page) continue;

			if (entry.cell.vertex === '1') v.push(cellInfo(entry));
			else if (entry.cell.edge === '1') e.push(cellInfo(entry));
		}

		vertexCount += v.length;
		edgeCount += e.length;
		pages.push({ name: page.name ?? null, id: page.id ?? null, vertices: v, edges: e });
	}

	return { pages, vertexCount, edgeCount };
}
