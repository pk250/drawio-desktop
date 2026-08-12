// Deterministic structural linter for .drawio diagrams.
//
// Port of the write-review "validate.py" step from the drawio skill: catches
// dangling edge endpoints, duplicate or reserved ids, broken parent
// references, and (as warnings) off-grid geometry, overlapping sibling nodes
// and edge-routing defects. Runs without launching draw.io, so it is the fast
// pre-check the write-review flow runs before anything is committed.
//
// Edge-routing warnings only apply to edges carrying explicit waypoints
// (<Array as="points">); auto-routed edges store no path in the XML, so they
// are not geometry-checked (no false positives). Endpoints honour
// exitX/exitY/entryX/entryY, and positions are resolved through containers.

import {
	getCells, cellId, getGeometry, getStyleKey, getWaypoints, toArray,
} from './xml-model.js';

const RESERVED = new Set(['0', '1']);

function isEdgeLabel(cell)
{
	if ((cell.style || '').includes('edgeLabel'))
	{
		return true;
	}

	const g = cell.mxGeometry;

	return g != null && g.relative === '1';
}

function rect(entry)
{
	const g = getGeometry(entry.cell);

	if (g == null)
	{
		return null;
	}

	const { x, y, width, height } = g;

	if ([x, y, width, height].some(v => v == null || isNaN(v)))
	{
		return null;
	}

	return [x, y, width, height];
}

function overlap(a, b)
{
	const [ax, ay, aw, ah] = a;
	const [bx, by, bw, bh] = b;

	return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

function absRect(entry, byId)
{
	const r = rect(entry);

	if (!r)
	{
		return null;
	}

	let [x, y, w, h] = r;
	let parent = entry.cell.parent ?? null;
	const seen = new Set();

	while (parent != null && byId.has(parent) && !seen.has(parent))
	{
		seen.add(parent);
		const p = byId.get(parent);

		if (p.cell.vertex === '1')
		{
			const pr = rect(p);

			if (pr)
			{
				x += pr[0];
				y += pr[1];
			}
		}

		parent = p.cell.parent ?? null;
	}

	return [x, y, w, h];
}

function endpoint(entry, end, byId)
{
	const vid = end === 'source' ? entry.cell.source : entry.cell.target;

	if (vid == null || !byId.has(vid))
	{
		return null;
	}

	const box = absRect(byId.get(vid), byId);

	if (!box)
	{
		return null;
	}

	const [x, y, w, h] = box;
	const style = entry.cell.style || '';
	const fx = parseFloat(getStyleKey(style, end === 'source' ? 'exitX' : 'entryX'));
	const fy = parseFloat(getStyleKey(style, end === 'source' ? 'exitY' : 'entryY'));

	return [x + (isNaN(fx) ? 0.5 : fx) * w, y + (isNaN(fy) ? 0.5 : fy) * h];
}

function edgeRoute(entry, byId)
{
	const waypoints = getWaypoints(entry.cell);

	if (waypoints.length === 0)
	{
		return null;
	}

	const s = endpoint(entry, 'source', byId);
	const t = endpoint(entry, 'target', byId);

	if (!s || !t)
	{
		return null;
	}

	return [s, ...waypoints.map(w => [w.x, w.y]), t];
}

function orient(a, b, c)
{
	const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

	return Math.abs(v) < 1e-9 ? 0 : (v > 0 ? 1 : -1);
}

function segmentsCross(p1, p2, p3, p4)
{
	const o1 = orient(p1, p2, p3);
	const o2 = orient(p1, p2, p4);
	const o3 = orient(p3, p4, p1);
	const o4 = orient(p3, p4, p2);

	return o1 !== o2 && o3 !== o4 && ![o1, o2, o3, o4].includes(0);
}

function pointInRect(p, box, eps = 1e-6)
{
	const [x, y, w, h] = box;

	return x + eps < p[0] && p[0] < x + w - eps && y + eps < p[1] && p[1] < y + h - eps;
}

function routeHitsRect(points, box)
{
	const [x, y, w, h] = box;
	const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
	const borders = corners.map((c, i) => [c, corners[(i + 1) % corners.length]]);

	for (let i = 0; i < points.length - 1; i++)
	{
		const a = points[i];
		const b = points[i + 1];

		if (pointInRect(a, box) || pointInRect(b, box))
		{
			return true;
		}

		if (borders.some(([c, d]) => segmentsCross(a, b, c, d)))
		{
			return true;
		}
	}

	return false;
}

function routesCross(pa, pb)
{
	for (let i = 0; i < pa.length - 1; i++)
	{
		for (let j = 0; j < pb.length - 1; j++)
		{
			if (segmentsCross(pa[i], pa[i + 1], pb[j], pb[j + 1]))
			{
				return true;
			}
		}
	}

	return false;
}

function geometryWarnings(cells, byId)
{
	const warns = [];
	const routed = [];

	for (const entry of cells)
	{
		if (entry.cell.edge !== '1') continue;

		const pts = edgeRoute(entry, byId);

		if (pts)
		{
			routed.push({ id: cellId(entry), pts, ends: new Set([entry.cell.source, entry.cell.target]) });
		}
	}

	const parents = new Set(cells.map(c => c.cell.parent));

	const leaves = cells
		.filter(entry =>
			entry.cell.vertex === '1' &&
			!parents.has(cellId(entry)) &&
			!isEdgeLabel(entry.cell))
		.map(entry => ({ id: cellId(entry), box: absRect(entry, byId) }))
		.filter(e => e.box);

	for (const r of routed)
	{
		for (const leaf of leaves)
		{
			if (!r.ends.has(leaf.id) && routeHitsRect(r.pts, leaf.box))
			{
				warns.push(`edge '${r.id}' routes through vertex '${leaf.id}'`);
			}
		}
	}

	for (let i = 0; i < routed.length; i++)
	{
		for (let j = i + 1; j < routed.length; j++)
		{
			if (routesCross(routed[i].pts, routed[j].pts))
			{
				warns.push(`edges '${routed[i].id}' and '${routed[j].id}' cross`);
			}
		}
	}

	return warns;
}

export function checkPage(page)
{
	const name = page.name ?? '?';
	const model = page.mxGraphModel;

	if (model == null)
	{
		if (page['#text'] && page['#text'].trim())
		{
			return [[], [`page '${name}': compressed, skipped (cannot lint)`]];
		}

		return [[`page '${name}': no <mxGraphModel>`], []];
	}

	const root = model.root;
	const errors = [];
	const warns = [];
	const cells = getCells({ mxfile: { diagram: [page] } });
	const byId = new Map();

	for (const entry of cells)
	{
		const id = cellId(entry);

		if (byId.has(id))
		{
			errors.push(`duplicate id '${id}'`);
		}

		byId.set(id, entry);
	}

	const parents = new Set(cells.map(c => c.cell.parent));

	for (const entry of cells)
	{
		const id = cellId(entry);
		const { cell } = entry;
		const isV = cell.vertex === '1';
		const isE = cell.edge === '1';

		if (cell.parent != null && !byId.has(cell.parent))
		{
			errors.push(`cell '${id}' parent '${cell.parent}' does not exist`);
		}

		for (const end of ['source', 'target'])
		{
			const ref = cell[end];

			if (ref != null && !byId.has(ref))
			{
				errors.push(`edge '${id}' ${end} '${ref}' does not exist`);
			}
		}

		if ((isV || isE) && RESERVED.has(id))
		{
			errors.push(`cell '${id}' reuses reserved id 0/1`);
		}

		if (isV && !isEdgeLabel(cell))
		{
			const r = rect(entry);

			if (!r)
			{
				errors.push(`vertex '${id}' has missing/invalid geometry`);
			}
			else
			{
				const [, , w, h] = r;

				if (w <= 0 || h <= 0)
				{
					warns.push(`vertex '${id}' non-positive size ${w}gx${h}g`);
				}

				if (r[0] < 0 || r[1] < 0)
				{
					warns.push(`vertex '${id}' negative position (${r[0]}g,${r[1]}g)`);
				}
			}
		}
	}

	// Sibling overlap: only leaf vertices (containers legitimately wrap children).
	const boxes = cells
		.filter(entry =>
			entry.cell.vertex === '1' &&
			!parents.has(cellId(entry)) &&
			!isEdgeLabel(entry.cell) &&
			rect(entry) != null)
		.map(entry => ({ id: cellId(entry), parent: entry.cell.parent, rect: rect(entry) }));

	for (let i = 0; i < boxes.length; i++)
	{
		for (let j = i + 1; j < boxes.length; j++)
		{
			const a = boxes[i];
			const b = boxes[j];

			if (a.parent === b.parent && overlap(a.rect, b.rect))
			{
				warns.push(`vertices '${a.id}' and '${b.id}' overlap`);
			}
		}
	}

	warns.push(...geometryWarnings(cells, byId));

	return [errors, warns];
}

export function validate(doc, { strict = false } = {})
{
	const errors = [];
	const warns = [];

	for (const page of toArray(doc.mxfile && doc.mxfile.diagram))
	{
		const [e, w] = checkPage(page);
		errors.push(...e);
		warns.push(...w);
	}

	const through = warns.filter(w => w.includes('routes through')).length;
	const cross = warns.filter(w => w.includes(' cross')).length;
	const olap = warns.filter(w => w.includes(' overlap')).length;
	const score = 20 * through + 10 * cross + 5 * olap;

	return { errors, warnings: warns, score, ok: errors.length === 0 && (!strict || warns.length === 0) };
}
