// Diagram export / layout via the draw.io CLI.
//
// The MCP server renders PNG/SVG/PDF/JPG and runs layout passes the same way
// the drawio skill does — by invoking the draw.io command line. When the MCP
// server runs inside the packaged app it spawns itself (`drawio -x ...`); when
// run as a plain Node process it looks for a `drawio`/`draw.io` binary on
// PATH. On headless Linux the command is wrapped with `xvfb-run`, and `--no-
// sandbox` is appended when running as root (CI/Docker).

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { repairPng } from './png-repair.js';

function which(bin)
{
	const dirs = (process.env.PATH || '').split(path.delimiter);

	for (const dir of dirs)
	{
		const p = path.join(dir, bin);

		try
		{
			if (fs.statSync(p).isFile() && (os.platform() !== 'win32' || p.endsWith('.exe')))
			{
				return p;
			}
		}
		catch (e)
		{
			// keep searching
		}
	}

	return null;
}

function isRoot()
{
	try
	{
		return typeof process.getuid === 'function' && process.getuid() === 0;
	}
	catch (e)
	{
		return false;
	}
}

function hasDisplay()
{
	return !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
}

// Resolve the command that starts the draw.io CLI on this machine.
// Returns { cmd, args } ready to be spread into spawn(), or null.
export function resolveDrawioCommand(config)
{
	if (config.drawioBin)
	{
		return { cmd: config.drawioBin, args: [] };
	}

	if (process.versions && process.versions.electron)
	{
		// Running inside the desktop app: spawn a second instance in export
		// mode. In dev (`electron .`) the app path must be passed explicitly.
		const args = process.defaultApp === true ? [config.appPath || process.cwd()] : [];

		return { cmd: process.execPath, args };
	}

	for (const name of ['drawio', 'draw.io'])
	{
		const p = which(name);

		if (p)
		{
			return { cmd: p, args: [] };
		}
	}

	return null;
}

export function exportTimeoutMs(config)
{
	const v = parseInt(process.env.DRAWIO_MCP_EXPORT_TIMEOUT_MS || '120000', 10);

	return isNaN(v) || v <= 0 ? 120000 : v;
}

/**
 * Export a diagram through the draw.io CLI.
 *
 *   diagramPath  input .drawio (or .mmd) file
 *   format       png | svg | pdf | jpg | xml | html
 *   outputPath   destination file
 *   opts         { scale, width, height, border, transparent, embedDiagram,
 *                  theme, pageIndex, pageRange, allPages, quality, uncompressed,
 *                  crop, size, layout }
 *
 * Resolves to { output, outputFormat, embedded, repaired, exitCode, stderr }.
 */
export function exportDiagram(config, diagramPath, format, outputPath, opts = {})
{
	const cmd = resolveDrawioCommand(config);

	if (!cmd)
	{
		throw new Error('draw.io CLI not found — install draw.io desktop, or set ' +
			'DRAWIO_MCP_DRAWIO_BIN to the binary path, to enable export');
	}

	const args = [...cmd.args, '-x', '-f', format, '-o', outputPath, diagramPath];

	if (opts.scale != null) args.unshift('--scale', String(opts.scale));
	if (opts.width != null) args.unshift('--width', String(opts.width));
	if (opts.height != null) args.unshift('--height', String(opts.height));
	if (opts.border != null) args.unshift('--border', String(opts.border));
	if (opts.theme) args.unshift('--theme', opts.theme);
	if (opts.size) args.unshift('--size', opts.size);
	if (opts.quality != null) args.unshift('--quality', String(opts.quality));
	if (opts.uncompressed) args.unshift('--uncompressed');
	if (opts.crop) args.unshift('--crop');
	if (opts.allPages) args.unshift('--all-pages');
	if (opts.embedDiagram) args.unshift('--embed-diagram');
	if (opts.transparent) args.unshift('--transparent');
	if (opts.pageIndex != null) args.unshift('--page-index', String(opts.pageIndex));
	if (opts.pageRange) args.unshift('--page-range', opts.pageRange);
	if (opts.layout) args.unshift('--layout', opts.layout);

	// Linux headless: wrap in xvfb-run unless a display is present.
	let runner = null;

	if (os.platform() === 'linux' && !hasDisplay())
	{
		const xvfb = which('xvfb-run');

		if (xvfb)
		{
			runner = xvfb;
			args.unshift('--server-args=-screen 0 1280x1024x24', '-a', '-x');
		}
		else
		{
			throw new Error('no display available and xvfb-run not found — ' +
				'install xvfb or run on a machine with a display to export');
		}
	}

	if (isRoot())
	{
		args.push('--no-sandbox');
	}

	const display = runner || cmd.cmd;

	return new Promise((resolve, reject) =>
	{
		const child = spawn(display, args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
		let stderr = '';
		let timedOut = false;

		const timer = setTimeout(() =>
		{
			timedOut = true;
			child.kill('SIGKILL');
		}, exportTimeoutMs(config));

		child.stderr.on('data', d => { stderr += d; });
		child.on('error', err => reject(err));
		child.on('close', code =>
		{
			clearTimeout(timer);

			if (timedOut)
			{
				reject(new Error(`export timed out after ${exportTimeoutMs(config)}ms`));
				return;
			}

			// draw.io CLI emits PNGs with a truncated IEND chunk; repair them
			// so strict decoders accept the file.
			let repaired = false;

			if (format === 'png')
			{
				try
				{
					repaired = repairPng(outputPath);
				}
				catch (e)
				{
					stderr += `\n[repair-png] ${e.message}`;
				}
			}

			resolve({ output: outputPath, outputFormat: format, stderr, exitCode: code, pngRepaired: repaired });
		});
	});
}
