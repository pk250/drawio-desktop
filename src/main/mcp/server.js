// Draw.io MCP server — tools, resources and prompts.
//
// Registers the full Model Context Protocol surface for diagram work:
//
//  - Read/analyze: read_diagram, get_diagram_info, describe_diagram,
//    validate_diagram, extract_labels, diff_diagrams, preview_diagram
//  - Write (always staged, never applied until review): edit_diagram,
//    create_diagram, apply_layout, restyle_diagram, relabel_diagram
//  - Write review: review_pending_changes, commit_changes, discard_changes
//  - Export / open: export_diagram, open_in_app
//  - Filesystem policy: list/add/remove_allowed_directory
//  - Info: session_info, list_preset_names
//
// The write-review contract mirrors the drawio skill's review loop: mutations
// land in the staging area, review_pending_changes exposes the structural diff
// (plus the deterministic lint from validator.js), and commit_changes is the
// only operation that touches the disk — gated by a fresh validation pass and
// an optimistic concurrency check against the original file.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createFsGuard } from './fsguard.js';
import { StagingArea } from './staging.js';
import {
	parseDiagram, serializeDiagram, diagramSummary, getCells, cellId, cellInfo,
	getCellValue, getStyleKey, setStyleKeys, findCell, setCellValue, setGeometry,
	addVertex, addEdge, removeCell, renamePage, addPage, removePage, setWaypoints,
	getPages, getRoot, toArray,
} from './xml-model.js';
import { validate } from './validator.js';
import { applyRestyle, listPresetNames } from './restyler.js';
import { resolvePreset } from './presets.js';
import { extractLabels, applyLabelMap } from './relabel.js';
import { diffDocuments, formatDiffReport } from './diff.js';
import { exportDiagram, resolveDrawioCommand } from './exporter.js';
import { repairPng } from './png-repair.js';

// --- result helpers ---------------------------------------------------------

function text(content)
{
	return { content: [{ type: 'text', text: content }] };
}

function jsonText(obj)
{
	return text(JSON.stringify(obj, null, 2));
}

function toolError(err)
{
	return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
}

function structured(shape, obj)
{
	return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj };
}

const READ_ONLY = { readOnlyHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true };
const MUTATING = { readOnlyHint: false, destructiveHint: false };

// --- edit operation schema --------------------------------------------------

const waypointsSchema = z.array(z.object({ x: z.number(), y: z.number() }));

const editOpSchema = z.discriminatedUnion('op', [
	z.object({ op: z.literal('setLabel'), id: z.string().describe('cell id'), value: z.string().describe('new label text') }),
	z.object({ op: z.literal('setStyleProperty'), id: z.string(), key: z.string(), value: z.string().nullable().optional().describe('null/omitted removes the property') }),
	z.object({ op: z.literal('setStyle'), id: z.string(), style: z.string().describe('full replacement style string') }),
	z.object({ op: z.literal('setColor'), id: z.string(), fill: z.string().optional(), stroke: z.string().optional(), font: z.string().optional() }),
	z.object({ op: z.literal('addVertex'), id: z.string().optional(), page: z.string().optional().describe('page name; default first page'), parent: z.string().optional(), value: z.string().optional(), style: z.string().optional(), x: z.number(), y: z.number(), width: z.number().optional(), height: z.number().optional() }),
	z.object({ op: z.literal('addEdge'), id: z.string().optional(), page: z.string().optional(), parent: z.string().optional(), source: z.string().describe('source cell id'), target: z.string().describe('target cell id'), label: z.string().optional(), style: z.string().optional(), waypoints: waypointsSchema.optional() }),
	z.object({ op: z.literal('removeCell'), id: z.string() }),
	z.object({ op: z.literal('moveCell'), id: z.string(), x: z.number().describe('absolute x'), y: z.number().describe('absolute y') }),
	z.object({ op: z.literal('resizeCell'), id: z.string(), width: z.number(), height: z.number() }),
	z.object({ op: z.literal('setEdgeWaypoints'), id: z.string(), waypoints: waypointsSchema }),
	z.object({ op: z.literal('addPage'), name: z.string() }),
	z.object({ op: z.literal('removePage'), name: z.string() }),
	z.object({ op: z.literal('renamePage'), name: z.string(), newName: z.string() }),
]);

// --- server factory ---------------------------------------------------------

export function createDrawioMcpServer(config)
{
	const guard = createFsGuard(config.cwd || process.cwd());
	const staging = new StagingArea();

	for (const dir of config.allowedDirs || [])
	{
		try
		{
			guard.addAllowed(dir);
		}
		catch (e)
		{
			// Skip roots that cannot be added; list_allowed_directories shows what stuck.
		}
	}

	const server = new McpServer({
		name: 'draw.io',
		version: config.version || '0.0.0',
	});

	const readOnly = config.readOnly;
	const autoCommit = config.autoCommit;
	const noStaging = config.noStaging;

	function requireWritable(mutatingOp)
	{
		if (readOnly)
		{
			throw new Error(`server is read-only (--mcp-readonly); '${mutatingOp}' is disabled`);
		}
	}

	// --- file access helpers -------------------------------------------------

	function readCurrent(path, { mustExist = true } = {})
	{
		const staged = staging.stagedContent(path);

		if (staged != null)
		{
			return { text: staged, source: 'staged' };
		}

		try
		{
			return { text: fs.readFileSync(path, 'utf8'), source: 'disk' };
		}
		catch (e)
		{
			if (mustExist)
			{
				throw new Error(`cannot read ${path}: ${e.message}`);
			}

			return { text: null, source: 'missing' };
		}
	}

	function parseCurrent(path)
	{
		const { text, source } = readCurrent(path);

		try
		{
			return { doc: parseDiagram(text), source };
		}
		catch (e)
		{
			throw new Error(`cannot parse ${path}: ${e.message}`);
		}
	}

	function stageWrite(target, newText, ops)
	{
		const slot = staging.set(target, newText, ops);
		let report = null;

		try
		{
			report = validate(parseDiagram(newText));
		}
		catch (e)
		{
			report = { errors: [`cannot validate staged content: ${e.message}`], warnings: [], score: 0, ok: false };
		}

		return { slot, report };
	}

	function materialize(text, { ext = '.drawio' } = {})
	{
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawio-mcp-'));
		const file = path.join(dir, `diagram${ext}`);

		fs.writeFileSync(file, text, 'utf8');

		return file;
	}

	function atomicWrite(filePath, content)
	{
		const dir = path.dirname(filePath);
		const tmp = path.join(dir, `.${path.basename(filePath)}.mcp-${process.pid}-${Date.now()}.tmp`);

		fs.writeFileSync(tmp, content, 'utf8');
		fs.renameSync(tmp, filePath);
	}

	// Resolve a file path through the guard and return its absolute form.
	function fileArg(p, { forWrite = false } = {})
	{
		if (readOnly && forWrite)
		{
			throw new Error('server is read-only (--mcp-readonly)');
		}

		return guard.assertAllowed(p, { forWrite });
	}

	function commitPath(target, force)
	{
		const slot = staging.get(target);

		if (!slot)
		{
			return { path: target, status: 'no-pending' };
		}

		if (!force)
		{
			const baselineErr = staging.checkBaseline(target);

			if (baselineErr)
			{
				throw new Error(`${baselineErr} (pass force=true to override)`);
			}
		}

		const report = validate(parseDiagram(slot.staged));

		if (!report.ok && !force)
		{
			const detail = report.errors.length > 0 ? report.errors.join('; ') : report.warnings.join('; ');

			throw new Error(`validation failed for ${target}: ${detail} (pass force=true to commit anyway)`);
		}

		guard.assertWritable(target);
		atomicWrite(target, slot.staged);
		staging.remove(target);

		return { path: target, status: 'committed', validation: report };
	}

	function pendingReport(target)
	{
		const slot = staging.get(target);

		if (!slot)
		{
			return null;
		}

		let diff = null;
		let validation = null;

		try
		{
			diff = diffDocuments(parseDiagram(slot.original || '<mxfile/>'), parseDiagram(slot.staged));
		}
		catch (e)
		{
			diff = { error: e.message };
		}

		try
		{
			validation = validate(parseDiagram(slot.staged));
		}
		catch (e)
		{
			validation = { errors: [`cannot validate: ${e.message}`], warnings: [], score: 0, ok: false };
		}

		return {
			path: target,
			ops: slot.ops,
			originalEtag: slot.originalEtag,
			hasOriginalOnDisk: slot.hasOriginalOnDisk,
			createdAt: slot.createdAt,
			updatedAt: slot.updatedAt,
			diff,
			validation,
		};
	}

	// --- tools ---------------------------------------------------------------

	server.registerTool(
		'session_info',
		{
			title: 'Session info',
			description: 'Server state: version, mode (read-only/auto-commit), allowed directories, pending write-review changes and draw.io CLI availability.',
			inputSchema: z.object({}),
			outputSchema: z.object({}).passthrough(),
			annotations: READ_ONLY,
		},
		async () =>
		{
			const info = {
				version: config.version || '0.0.0',
				mode: {
					readOnly,
					autoCommit,
					writeReview: !noStaging && !autoCommit,
				},
				cwd: guard.cwd,
				allowedDirectories: guard.list(),
				pending: staging.count(),
				drawioCli: resolveDrawioCommand(config) ? 'available' : 'missing',
				exportTimeoutMs: Number(process.env.DRAWIO_MCP_EXPORT_TIMEOUT_MS || 120000),
			};

			return structured({}, info);
		});

	server.registerTool(
		'list_allowed_directories',
		{
			title: 'List allowed directories',
			description: 'List the directories the MCP server may read from and write to. The working directory is always allowed; others are added with add_allowed_directory.',
			inputSchema: z.object({}),
			outputSchema: z.object({ directories: z.array(z.string()) }),
			annotations: READ_ONLY,
		},
		async () => structured({}, { directories: guard.list() }));

	server.registerTool(
		'add_allowed_directory',
		{
			title: 'Allow a directory',
			description: 'Grant the MCP server access to a directory (and its subdirectories). Diagram files outside allowed roots are rejected.',
			inputSchema: z.object({ path: z.string().describe('directory to allow, absolute or relative to the server working dir') }),
			annotations: MUTATING,
		},
		async ({ path: dir }) =>
		{
			const real = guard.addAllowed(dir);

			return text(`allowed ${real}`);
		});

	server.registerTool(
		'remove_allowed_directory',
		{
			title: 'Revoke a directory',
			description: 'Remove an allowed directory. The working directory itself cannot be removed.',
			inputSchema: z.object({ path: z.string() }),
			annotations: MUTATING,
		},
		async ({ path: dir }) =>
		{
			const removed = guard.removeAllowed(dir);

			return text(removed ? `removed ${dir}` : `no such allowed directory: ${dir}`);
		});

	server.registerTool(
		'read_diagram',
		{
			title: 'Read a diagram',
			description: 'Return the raw .drawio XML of a diagram (staged content if a pending change exists, else the file on disk).',
			inputSchema: z.object({ path: z.string() }),
			annotations: READ_ONLY,
		},
		async ({ path: p }) =>
		{
			const target = fileArg(p);
			const { text: xml, source } = readCurrent(target);

			if (xml == null)
			{
				return toolError(new Error(`file not found: ${target}`));
			}

			const header = `# ${target}\nsource: ${source}\n`;
			const out = source === 'staged' ? `${header}\n(WARNING: staged content — not yet written to disk)\n\n${xml}` : `${header}\n\n${xml}`;

			return text(out);
		});

	server.registerTool(
		'get_diagram_info',
		{
			title: 'Diagram info',
			description: 'Structural summary of a diagram: pages, vertex/edge counts, cell details, and whether a pending staged version exists.',
			inputSchema: z.object({
				path: z.string(),
				includeCells: z.boolean().optional().describe('include full per-cell detail (default false)'),
			}),
			outputSchema: z.object({}).passthrough(),
			annotations: READ_ONLY,
		},
		async ({ path: p, includeCells }) =>
		{
			const target = fileArg(p);
			const { doc, source } = parseCurrent(target);
			const summary = diagramSummary(doc);
			let stat = null;

			try
			{
				stat = fs.statSync(target);
			}
			catch (e)
			{
				// new file staged only
			}

			const pages = summary.pages.map(pg => ({
				name: pg.name,
				vertexCount: pg.vertices.length,
				edgeCount: pg.edges.length,
				cells: includeCells ? [...pg.vertices, ...pg.edges] : undefined,
			}));

			const info = {
				path: target,
				source,
				pending: staging.has(target),
				fileSize: stat ? stat.size : null,
				modified: stat ? stat.mtime.toISOString() : null,
				vertexCount: summary.vertexCount,
				edgeCount: summary.edgeCount,
				pages,
			};

			return structured({}, info);
		});

	server.registerTool(
		'describe_diagram',
		{
			title: 'Describe a diagram',
			description: 'Human-readable Markdown description of a diagram: per-page lists of shapes (labels, styles, positions) and connections. The reverse of generating one — useful for a README/PR summary.',
			inputSchema: z.object({ path: z.string() }),
			annotations: READ_ONLY,
		},
		async ({ path: p }) =>
		{
			const target = fileArg(p);
			const { doc, source } = parseCurrent(target);
			const lines = [`# ${path.basename(target)}`, `source: ${source}`, ''];

			for (const page of getPages(doc))
			{
				const name = page.name || '(unnamed page)';
				const cells = getCells({ mxfile: { diagram: [page] } });
				const verts = cells.filter(c => c.cell.vertex === '1');
				const edges = cells.filter(c => c.cell.edge === '1');

				lines.push(`## ${name}`, '', `### Shapes (${verts.length})`, '');

				const grouped = new Map();

				for (const v of verts)
				{
					const parent = v.cell.parent || '1';
					const list = grouped.get(parent) || [];
					list.push(v);
					grouped.set(parent, list);
				}

				for (const [parent, list] of grouped)
				{
					if (parent !== '1')
					{
						const pe = findCell(doc, parent);
						lines.push(`**container ${parent}${pe ? ` (${getCellValue(pe)})` : ''}**`);
					}

					for (const v of list)
					{
						const info = cellInfo(v);
						const g = info.width != null ? ` at (${info.x},${info.y}) ${info.width}x${info.height}` : '';

						lines.push(`- \`${info.id}\` "${info.value || ''}"${g}${info.style ? `  _style: ${info.style}_` : ''}`);
					}
				}

				lines.push('', `### Connections (${edges.length})`, '');

				for (const e of edges)
				{
					const info = cellInfo(e);
					const label = info.value ? ` "${info.value}"` : '';
					lines.push(`- \`${info.id}\` ${info.source} -> ${info.target}${label}`);
				}

				lines.push('');
			}

			return text(lines.join('\n'));
		});

	server.registerTool(
		'validate_diagram',
		{
			title: 'Validate a diagram',
			description: 'Deterministic structural lint (the write-review pre-check): dangling edges, duplicate/reserved ids, broken parents, missing geometry, sibling overlaps, edge-routing defects, plus a readability score.',
			inputSchema: z.object({ path: z.string(), strict: z.boolean().optional().describe('treat warnings as failures (default false)') }),
			outputSchema: z.object({}).passthrough(),
			annotations: READ_ONLY,
		},
		async ({ path: p, strict }) =>
		{
			const target = fileArg(p);
			const { doc, source } = parseCurrent(target);
			const report = validate(doc, { strict: !!strict });

			return structured({}, { path: target, source, ...report });
		});

	server.registerTool(
		'extract_labels',
		{
			title: 'Extract diagram labels',
			description: 'Extract every non-empty label into an identity JSON map for relabel_diagram (e.g. for translating a diagram without moving geometry).',
			inputSchema: z.object({ path: z.string() }),
			outputSchema: z.object({ labels: z.record(z.string(), z.string()) }),
			annotations: READ_ONLY,
		},
		async ({ path: p }) =>
		{
			const target = fileArg(p);
			const { doc } = parseCurrent(target);
			const labels = extractLabels(doc);

			return structured({ labels }, { labels });
		});

	server.registerTool(
		'diff_diagrams',
		{
			title: 'Diff two diagrams',
			description: 'Structural diff between two .drawio files (staged content is used when a file has pending changes): added / removed / changed cells and unchanged count. Match by cell id (default) or by visible label.',
			inputSchema: z.object({
				path1: z.string(),
				path2: z.string(),
				byLabel: z.boolean().optional().describe('match cells by visible label instead of id (default false)'),
			}),
			outputSchema: z.object({}).passthrough(),
			annotations: READ_ONLY,
		},
		async ({ path1, path2, byLabel }) =>
		{
			const t1 = fileArg(path1);
			const t2 = fileArg(path2);
			const { text: a } = readCurrent(t1);
			const { text: b } = readCurrent(t2);

			if (a == null || b == null)
			{
				return toolError(new Error('both files must exist or have staged content'));
			}

			const diff = diffDocuments(parseDiagram(a), parseDiagram(b), { byLabel: !!byLabel });
			const summary = {
				added: diff.added.length,
				removed: diff.removed.length,
				changed: diff.changed.length,
				same: diff.same,
				details: diff,
			};

			return structured({}, summary);
		});

	// --- write-review tools --------------------------------------------------

	server.registerTool(
		'edit_diagram',
		{
			title: 'Edit a diagram (staged)',
			description: 'Apply targeted edits to a diagram — change labels/colors/styles, add/remove/move/resize shapes and edges, manage pages. ALL changes are staged for write review: nothing touches the disk until commit_changes. Chain multiple ops in one call.',
			inputSchema: z.object({ path: z.string(), ops: z.array(editOpSchema) }),
			annotations: MUTATING,
		},
		async (args) =>
		{
			try
			{
				requireWritable('edit_diagram');
				const target = fileArg(args.path, { forWrite: true });
				const { doc } = parseCurrent(target);
				const summaries = [];

				for (const op of args.ops)
				{
					summaries.push({ op: op.op, summary: applyEditOp(doc, op) });
				}

				const staged = serializeDiagram(doc);
				const { report } = stageWrite(target, staged, summaries);

				if (noStaging)
				{
					const res = commitPath(target, false);
					return text(formatCommitMessage([res], report));
				}

				return text(`staged edits for ${target} (${summaries.length} op(s)):\n${summaries.map(s => `- ${s.summary}`).join('\n')}\n\n` + formatValidation(report) + `\n\nReview with review_pending_changes, then commit_changes or discard_changes.`);
			}
			catch (e)
			{
				return toolError(e);
			}
		});

	server.registerTool(
		'create_diagram',
		{
			title: 'Create a diagram (staged)',
			description: 'Create a new .drawio file (empty pages, or from an initial XML document). Staged for write review — commit_changes writes it to disk.',
			inputSchema: z.object({
				path: z.string().describe('output file path'),
				pages: z.array(z.string()).optional().describe('page names (default ["Page-1"])'),
				initialXml: z.string().optional().describe('full .drawio XML to start from'),
				overwrite: z.boolean().optional().describe('allow staging over an existing file (default false)'),
			}),
			annotations: MUTATING,
		},
		async (args) =>
		{
			try
			{
				requireWritable('create_diagram');
				const target = fileArg(args.path, { forWrite: true });

				if (!args.overwrite && !staging.has(target) && fs.existsSync(target))
				{
					return toolError(new Error(`file already exists: ${target} (pass overwrite=true to replace it)`));
				}

				let doc;

				if (args.initialXml)
				{
					doc = parseDiagram(args.initialXml);
				}
				else
				{
					doc = emptyDocument(args.pages && args.pages.length > 0 ? args.pages : ['Page-1']);
				}

				const staged = serializeDiagram(doc);
				const ops = [{ op: 'create', summary: `created ${target} with ${getPages(doc).length} page(s)` }];
				const { report } = stageWrite(target, staged, ops);

				if (noStaging)
				{
					const res = commitPath(target, false);

					return text(formatCommitMessage([res], report));
				}

				return text(`staged new diagram at ${target}\n${formatValidation(report)}\n\nReview with review_pending_changes, then commit_changes.`);
			}
			catch (e)
			{
				return toolError(e);
			}
		});

	server.registerTool(
		'apply_layout',
		{
			title: 'Auto-layout a diagram (staged)',
			description: 'Re-run a layout pass on a diagram (draw.io CLI >= v30): verticalFlow, horizontalFlow, verticalTree, horizontalTree, radialTree or organic. Nodes and edge routing are re-placed; the result is staged for write review.',
			inputSchema: z.object({
				path: z.string(),
				layout: z.enum(['verticalFlow', 'horizontalFlow', 'verticalTree', 'horizontalTree', 'radialTree', 'organic']),
			}),
			annotations: MUTATING,
		},
		async (args) =>
		{
			try
			{
				requireWritable('apply_layout');
				const target = fileArg(args.path, { forWrite: true });
				const { text: current } = readCurrent(target);

				if (current == null)
				{
					return toolError(new Error(`file not found: ${target}`));
				}

				const input = materialize(current);
				const output = path.join(path.dirname(input), 'layout.xml');
				const result = await exportDiagram(config, input, 'xml', output, { layout: args.layout });

				if (result.exitCode !== 0 || !fs.existsSync(output))
				{
					return toolError(new Error(`layout pass failed (exit ${result.exitCode}): ${result.stderr}`));
				}

				const staged = fs.readFileSync(output, 'utf8');
				const { report } = stageWrite(target, staged, [{ op: 'layout', summary: `applied layout '${args.layout}'` }]);

				if (noStaging)
				{
					const res = commitPath(target, false);

					return text(formatCommitMessage([res], report));
				}

				return text(`staged layout '${args.layout}' for ${target}\n${formatValidation(report)}\n\nReview with review_pending_changes, then commit_changes.`);
			}
			catch (e)
			{
				return toolError(e);
			}
		});

	server.registerTool(
		'restyle_diagram',
		{
			title: 'Restyle a diagram (staged)',
			description: 'Re-theme an existing diagram with a style preset. Every vertex fill/stroke is remapped to the preset palette by nearest hue; the preset font and extras (background, edge color, font color) are layered on. Preset: a built-in name (default, dark, corporate), a JSON file path, or a ~/.drawio-skill/styles/<name>.json user preset. Staged for write review.',
			inputSchema: z.object({
				path: z.string(),
				preset: z.string().describe('preset name, JSON file path, or user preset name'),
			}),
			annotations: MUTATING,
		},
		async (args) =>
		{
			try
			{
				requireWritable('restyle_diagram');
				const target = fileArg(args.path, { forWrite: true });
				const preset = resolvePreset(args.preset);
				const { doc } = parseCurrent(target);
				const { vertices, edges } = applyRestyle(doc, preset);
				const staged = serializeDiagram(doc);
				const { report } = stageWrite(target, staged, [{ op: 'restyle', summary: `applied preset '${args.preset}' (${vertices} vertices, ${edges} edges)` }]);

				if (noStaging)
				{
					const res = commitPath(target, false);

					return text(formatCommitMessage([res], report));
				}

				return text(`staged restyle of ${target} with preset '${args.preset}' (${vertices} vertices, ${edges} edges)\n${formatValidation(report)}\n\nReview with review_pending_changes, then commit_changes.`);
			}
			catch (e)
			{
				return toolError(e);
			}
		});

	server.registerTool(
		'relabel_diagram',
		{
			title: 'Relabel a diagram (staged)',
			description: 'Bulk-swap labels via a {old: new} map (extract one with extract_labels, translate the values, apply). Geometry, styles and ids are untouched — ideal for language variants. Staged for write review.',
			inputSchema: z.object({
				path: z.string(),
				labels: z.record(z.string(), z.string()).describe('{old label: new label}'),
			}),
			annotations: MUTATING,
		},
		async (args) =>
		{
			try
			{
				requireWritable('relabel_diagram');
				const target = fileArg(args.path, { forWrite: true });
				const { doc } = parseCurrent(target);
				const { replaced, unused } = applyLabelMap(doc, args.labels);
				const staged = serializeDiagram(doc);
				const { report } = stageWrite(target, staged, [{ op: 'relabel', summary: `replaced ${replaced} label(s)` }]);

				const unusedNote = unused.length > 0 ? `\n${unused.length} map key(s) matched no label: ${unused.slice(0, 10).join(', ')}` : '';

				if (noStaging)
				{
					const res = commitPath(target, false);

					return text(formatCommitMessage([res], report) + unusedNote);
				}

				return text(`staged relabel of ${target} (${replaced} label(s) replaced)${unusedNote}\n${formatValidation(report)}\n\nReview with review_pending_changes, then commit_changes.`);
			}
			catch (e)
			{
				return toolError(e);
			}
		});

	server.registerTool(
		'list_preset_names',
		{
			title: 'List style presets',
			description: 'List the built-in style preset names accepted by restyle_diagram.',
			inputSchema: z.object({}),
			outputSchema: z.object({ presets: z.array(z.string()) }),
			annotations: READ_ONLY,
		},
		async () => structured({ presets: listPresetNames() }, { presets: listPresetNames() }));

	// --- write review: inspect / approve / discard --------------------------

	server.registerTool(
		'review_pending_changes',
		{
			title: 'Review pending changes',
			description: 'Write review: show every staged (not yet committed) change, with the operation log, the structural diff against the on-disk file, and the validation report. Nothing is written to disk until commit_changes.',
			inputSchema: z.object({ path: z.string().optional().describe('only this file; omit for all pending') }),
			outputSchema: z.object({ pending: z.array(z.any()) }).passthrough(),
			annotations: READ_ONLY,
		},
		async ({ path: p }) =>
		{
			let targets = staging.list().map(s => s.path);

			if (p)
			{
				const target = fileArg(p);
				targets = targets.filter(t => t === target);
			}

			const pending = targets.map(pendingReport).filter(Boolean);
			const lines = [];

			if (pending.length === 0)
			{
				lines.push('no pending write-review changes');
			}

			for (const item of pending)
			{
				lines.push(`## ${item.path}`, '', `ops: ${item.ops.map(o => o.summary).join('; ') || 'none'}`, '');

				if (item.diff && !item.diff.error)
				{
					lines.push(formatDiffReport(item.diff), '');
				}

				lines.push(formatValidation(item.validation), '');
			}

			return structured({ pending }, { pending, summary: lines.join('\n') });
		});

	server.registerTool(
		'commit_changes',
		{
			title: 'Approve and commit pending changes',
			description: 'Write review approval: write staged changes to disk. Re-validates the staged content (errors block the commit unless force=true) and verifies the file was not changed on disk after staging. This is the ONLY operation that modifies diagram files.',
			inputSchema: z.object({
				path: z.string().optional().describe('only this file; omit for all pending'),
				force: z.boolean().optional().describe('commit despite validation errors or a changed baseline (default false)'),
			}),
			annotations: DESTRUCTIVE,
		},
		async ({ path: p, force }) =>
		{
			try
			{
				let targets = staging.list().map(s => s.path);

				if (p)
				{
					const target = fileArg(p, { forWrite: true });
					targets = targets.filter(t => t === target);
				}

				const results = targets.map(t => commitPath(t, !!force));
				const summary = results
					.filter(r => r.status === 'committed')
					.map(r => `committed ${r.path}`)
					.join('\n');

				return text(summary || 'no pending changes to commit');
			}
			catch (e)
			{
				return toolError(e);
			}
		});

	server.registerTool(
		'discard_changes',
		{
			title: 'Discard pending changes',
			description: 'Write review rejection: abandon staged changes for a file (or all files). The file on disk is untouched.',
			inputSchema: z.object({ path: z.string().optional().describe('only this file; omit for all pending') }),
			annotations: DESTRUCTIVE,
		},
		async ({ path: p }) =>
		{
			let targets = staging.list().map(s => s.path);

			if (p)
			{
				const target = fileArg(p);
				targets = targets.filter(t => t === target);
			}

			for (const t of targets)
			{
				staging.remove(t);
			}

			return text(targets.length > 0 ? `discarded pending changes for ${targets.length} file(s)` : 'no pending changes to discard');
		});

	// --- export / open ------------------------------------------------------

	server.registerTool(
		'export_diagram',
		{
			title: 'Export a diagram',
			description: 'Render a diagram to png/svg/pdf/jpg/xml/html with the draw.io CLI. Exports the staged content when a pending change exists. Use -e embedding (drawio-embedDiagram) for editable outputs; PNG embeds are auto-repaired.',
			inputSchema: z.object({
				path: z.string().describe('input diagram'),
				format: z.enum(['png', 'svg', 'pdf', 'jpg', 'xml', 'html']),
				output: z.string().optional().describe('output file (default: input name with the format extension)'),
				scale: z.number().optional(),
				width: z.number().optional().describe('fit into width px'),
				height: z.number().optional().describe('fit into height px'),
				border: z.number().optional(),
				transparent: z.boolean().optional(),
				embedDiagram: z.boolean().optional().describe('-e: embed the diagram XML in the output (png/svg/pdf)'),
				theme: z.enum(['dark', 'light', 'auto']).optional(),
				pageIndex: z.number().optional().describe('1-based page'),
				pageRange: z.string().optional().describe('e.g. "2..3", PDF only'),
				allPages: z.boolean().optional(),
				quality: z.number().optional().describe('JPEG quality (default 90)'),
				crop: z.boolean().optional(),
				size: z.enum(['diagram', 'page']).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		async (args) =>
		{
			try
			{
				const target = fileArg(args.path);
				const output = args.output
					? fileArg(args.output, { forWrite: true })
					: path.join(path.dirname(target), `${path.basename(target, path.extname(target))}.${args.format}`);
				const { text: current } = readCurrent(target);

				if (current == null)
				{
					return toolError(new Error(`file not found: ${target}`));
				}

				const input = materialize(current);
				guard.assertWritable(output);

				const result = await exportDiagram(config, input, args.format, output, {
					scale: args.scale,
					width: args.width,
					height: args.height,
					border: args.border,
					transparent: args.transparent,
					embedDiagram: args.embedDiagram,
					theme: args.theme,
					pageIndex: args.pageIndex,
					pageRange: args.pageRange,
					allPages: args.allPages,
					quality: args.quality,
					crop: args.crop,
					size: args.size,
				});

				if (result.exitCode !== 0)
				{
					return toolError(new Error(`export failed (exit ${result.exitCode}): ${result.stderr}`));
				}

				let repaired = false;

				if (args.format === 'png' && args.embedDiagram)
				{
					repaired = repairPng(output);
				}

				return text(`exported ${output} (${args.format})${repaired ? ', repaired PNG IEND chunk' : ''}`);
			}
			catch (e)
			{
				return toolError(e);
			}
		});

	server.registerTool(
		'preview_diagram',
		{
			title: 'Preview a diagram',
			description: 'Export a width-capped PNG draft (default 2000px, no embedding) for visual review — the self-check preview from the drawio skill. Returns the output path.',
			inputSchema: z.object({
				path: z.string(),
				output: z.string().optional(),
				width: z.number().optional().describe('target width px (default 2000)'),
			}),
			annotations: READ_ONLY,
		},
		async (args) =>
		{
			try
			{
				const target = fileArg(args.path);
				const output = args.output
					? fileArg(args.output, { forWrite: true })
					: path.join(path.dirname(target), `${path.basename(target, path.extname(target))}.png`);
				const { text: current } = readCurrent(target);

				if (current == null)
				{
					return toolError(new Error(`file not found: ${target}`));
				}

				const input = materialize(current);
				guard.assertWritable(output);

				const result = await exportDiagram(config, input, 'png', output, { width: args.width || 2000 });

				if (result.exitCode !== 0)
				{
					return toolError(new Error(`preview failed (exit ${result.exitCode}): ${result.stderr}`));
				}

				return text(`preview: ${output}`);
			}
			catch (e)
			{
				return toolError(e);
			}
		});

	server.registerTool(
		'open_in_app',
		{
			title: 'Open in draw.io desktop',
			description: 'Open a diagram file in the draw.io desktop application (GUI) for fine-grained manual editing.',
			inputSchema: z.object({ path: z.string() }),
			annotations: READ_ONLY,
		},
		async ({ path: p }) =>
		{
			try
			{
				const target = fileArg(p);
				const cmd = resolveDrawioCommand(config);

				if (cmd)
				{
					const child = spawnDetached(cmd.cmd, [...cmd.args, target]);

					return text(`opening ${target} in draw.io desktop (pid ${child.pid || '?'})`);
				}

				if (os.platform() === 'darwin')
				{
					spawnDetached('open', [target]);

					return text(`opening ${target} with 'open'`);
				}

				if (os.platform() === 'win32')
				{
					spawnDetached('cmd.exe', ['/c', 'start', '', target]);

					return text(`opening ${target} with 'start'`);
				}

				spawnDetached('xdg-open', [target]);

				return text(`opening ${target} with xdg-open`);
			}
			catch (e)
			{
				return toolError(e);
			}
		});

	// --- resources -----------------------------------------------------------

	server.registerResource(
		'server-info',
		'drawio://server/info',
		{
			title: 'Draw.io MCP server info',
			mimeType: 'application/json',
			description: 'Server version, mode, allowed directories and pending change count.',
		},
		async () =>
		{
			const info = {
				name: 'draw.io',
				version: config.version || '0.0.0',
				readOnly,
				autoCommit,
				writeReview: !noStaging && !autoCommit,
				allowedDirectories: guard.list(),
				pending: staging.count(),
				cwd: guard.cwd,
			};

			return { contents: [{ uri: 'drawio://server/info', mimeType: 'application/json', text: JSON.stringify(info, null, 2) }] };
		});

	const diagramTemplate = new ResourceTemplate('drawio://diagram/{path}', {});
	const pageTemplate = new ResourceTemplate('drawio://diagram/{path}/pages/{page}', {});

	server.registerResource(
		'diagram',
		diagramTemplate,
		{
			title: 'Draw.io diagram',
			mimeType: 'application/xml',
			description: 'The .drawio XML of a diagram (staged content when pending).',
		},
		async (uri, variables) =>
		{
			const target = fileArg(decodeURIComponent(variables.path));
			const { text: xml, source } = readCurrent(target);

			if (xml == null)
			{
				throw new Error(`file not found: ${target}`);
			}

			return {
				contents: [{ uri: uri.toString(), mimeType: 'application/xml', text: source === 'staged' ? xml : xml }],
			};
		});

	server.registerResource(
		'diagram-page',
		pageTemplate,
		{
			title: 'Draw.io diagram page',
			mimeType: 'application/xml',
			description: 'A single page of a .drawio diagram as XML.',
		},
		async (uri, variables) =>
		{
			const target = fileArg(decodeURIComponent(variables.path));
			const pageName = decodeURIComponent(variables.page);
			const { doc } = parseCurrent(target);
			const page = getPages(doc).find(p => p.name === pageName);

			if (!page)
			{
				throw new Error(`page '${pageName}' not found in ${target}`);
			}

			const wrapper = {
				mxfile: {
					host: doc.mxfile.host,
					version: doc.mxfile.version,
					type: 'device',
					diagram: [page],
				},
			};

			return { contents: [{ uri: uri.toString(), mimeType: 'application/xml', text: serializeDiagram(wrapper) }] };
		});

	// --- prompts -------------------------------------------------------------

	server.registerPrompt(
		'review-diagram',
		{
			title: 'Review a diagram',
			description: 'Instructs the model to structurally review a diagram (validate_diagram + preview_diagram) and propose targeted edit_diagram ops.',
			argsSchema: { path: z.string() },
		},
		async ({ path: p }) =>
		{
			const target = fileArg(p);

			return {
				messages: [
					{
						role: 'user',
						content: {
							type: 'text',
							text: `Review the draw.io diagram at ${target}.\n\n` +
								'1. Run validate_diagram to catch structural defects (dangling edges, overlaps, broken refs).\n' +
								'2. Run preview_diagram to export a PNG and inspect it visually.\n' +
								'3. Summarise the diagram and list concrete issues.\n' +
								'4. If fixes are warranted, apply them with edit_diagram ops (staged), show review_pending_changes, and stop before commit_changes for my approval.',
						},
					},
				],
			};
		});

	server.registerPrompt(
		'create-diagram',
		{
			title: 'Create a diagram',
			description: 'Guides the model through creating a diagram from a description using the write-review flow.',
			argsSchema: { path: z.string(), description: z.string() },
		},
		async ({ path: p, description }) =>
		{
			const target = fileArg(p, { forWrite: true });

			return {
				messages: [
					{
						role: 'user',
						content: {
							type: 'text',
							text: `Create a draw.io diagram at ${target}.\n\nUser's description: ${description}\n\n` +
								'Workflow:\n' +
								'1. create_diagram with overwrite=true, then edit_diagram ops to add shapes (addVertex) and connections (addEdge) — or pass a full initialXml built by hand.\n' +
								'2. validate_diagram on the staged content and fix errors.\n' +
								'3. preview_diagram and review the PNG.\n' +
								'4. Iterate with edit_diagram until it looks right.\n' +
								'5. Present review_pending_changes and wait for my approval before commit_changes.',
						},
					},
				],
			};
		});

	server.registerPrompt(
		'write-review-policy',
		{
			title: 'Write review policy',
			description: 'Explains the staging / review / commit contract the server enforces for every write.',
			argsSchema: {},
		},
		async () =>
		{
			return {
				messages: [
					{
						role: 'user',
						content: {
							type: 'text',
							text: 'Write-review policy for this draw.io MCP server:\n\n' +
								'- Mutating tools (edit_diagram, create_diagram, apply_layout, restyle_diagram, relabel_diagram) only stage changes in memory.\n' +
								'- Use review_pending_changes to show the structural diff and validation before committing.\n' +
								'- commit_changes is the ONLY operation that writes diagram files to disk; it re-validates and refuses when errors exist (force=true overrides).\n' +
								'- discard_changes abandons staged work.\n' +
								'- Never call commit_changes without first presenting review_pending_changes to the user.',
						},
					},
				],
			};
		});

	return server;

	// --- edit op implementation ---------------------------------------------

	function applyEditOp(doc, op)
	{
		switch (op.op)
		{
			case 'setLabel':
			{
				const e = findCell(doc, op.id);

				if (!e) throw new Error(`cell '${op.id}' does not exist`);
				setCellValue(e, op.value);

				return `set label of '${op.id}' to "${op.value}"`;
			}
			case 'setStyleProperty':
			{
				const e = findCell(doc, op.id);

				if (!e) throw new Error(`cell '${op.id}' does not exist`);
				e.cell.style = setStyleKeys(e.cell.style || '', { [op.key]: op.value ?? null });

				return op.value != null
					? `set ${op.key}=${op.value} on '${op.id}'`
					: `removed ${op.key} from '${op.id}'`;
			}
			case 'setStyle':
			{
				const e = findCell(doc, op.id);

				if (!e) throw new Error(`cell '${op.id}' does not exist`);
				e.cell.style = op.style;

				return `set style of '${op.id}'`;
			}
			case 'setColor':
			{
				const e = findCell(doc, op.id);

				if (!e) throw new Error(`cell '${op.id}' does not exist`);
				const kv = {};

				if (op.fill != null) kv.fillColor = op.fill;
				if (op.stroke != null) kv.strokeColor = op.stroke;
				if (op.font != null) kv.fontColor = op.font;
				e.cell.style = setStyleKeys(e.cell.style || '', kv);

				return `set color(s) on '${op.id}'${op.fill ? ` fill=${op.fill}` : ''}${op.stroke ? ` stroke=${op.stroke}` : ''}${op.font ? ` font=${op.font}` : ''}`;
			}
			case 'addVertex':
			{
				const res = addVertex(doc, op);

				return `added vertex '${res.id}' to page '${res.page}'`;
			}
			case 'addEdge':
			{
				const res = addEdge(doc, op);

				return `added edge '${res.id}' ${op.source} -> ${op.target}`;
			}
			case 'removeCell':
			{
				const res = removeCell(doc, op.id);

				return `removed cell '${res.removed}' (and edges referencing it)`;
			}
			case 'moveCell':
			{
				const e = findCell(doc, op.id);

				if (!e) throw new Error(`cell '${op.id}' does not exist`);
				setGeometry(e.cell, { x: op.x, y: op.y });

				return `moved '${op.id}' to (${op.x},${op.y})`;
			}
			case 'resizeCell':
			{
				const e = findCell(doc, op.id);

				if (!e) throw new Error(`cell '${op.id}' does not exist`);
				setGeometry(e.cell, { width: op.width, height: op.height });

				return `resized '${op.id}' to ${op.width}x${op.height}`;
			}
			case 'setEdgeWaypoints':
			{
				const e = findCell(doc, op.id);

				if (!e) throw new Error(`cell '${op.id}' does not exist`);
				setWaypoints(e.cell, op.waypoints);

				return `set ${op.waypoints.length} waypoint(s) on '${op.id}'`;
			}
			case 'addPage':
			{
				const res = addPage(doc, op.name);

				return `added page '${res.name}'`;
			}
			case 'removePage':
			{
				const res = removePage(doc, op.name);

				return `removed page '${res.removed}'`;
			}
			case 'renamePage':
			{
				const res = renamePage(doc, op.name, op.newName);

				return `renamed page '${res.from}' -> '${res.to}'`;
			}
			default:
				throw new Error(`unknown edit op '${op.op}'`);
		}
	}
}

// --- helpers ----------------------------------------------------------------

function emptyDocument(pageNames)
{
	return {
		mxfile: {
			host: 'app.diagrams.net',
			type: 'device',
			diagram: pageNames.map(name => ({
				id: `page-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
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
					root: { mxCell: [{ id: '0' }, { id: '1', parent: '0' }] },
				},
			})),
		},
	};
}

function formatValidation(report)
{
	const lines = [`validation: ${report.errors.length} error(s), ${report.warnings.length} warning(s)`];

	for (const e of report.errors) lines.push(`  error: ${e}`);
	for (const w of report.warnings) lines.push(`  warning: ${w}`);

	return lines.join('\n');
}

function formatCommitMessage(results, lastReport)
{
	const lines = [];

	for (const r of results)
	{
		if (r.status === 'committed')
		{
			lines.push(`committed ${r.path}`);
		}
		else if (r.status === 'no-pending')
		{
			lines.push(`no pending changes for ${r.path}`);
		}
	}

	if (lastReport)
	{
		lines.push('', formatValidation(lastReport));
	}

	return lines.join('\n');
}

function spawnDetached(cmd, args)
{
	const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });

	child.unref();

	return child;
}
