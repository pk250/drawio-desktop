// Filesystem guard for the MCP server.
//
// The draw.io desktop app is security-first: diagram data never leaves the
// machine without the user's explicit action. The MCP server applies the same
// principle to file access — every path a tool touches (read or write) must
// resolve inside an explicitly allowed directory, real-pathed so symlinks
// cannot smuggle access out of the sandbox.
//
// The process working directory is always allowed implicitly. Extra roots can
// be granted by the client with add_allowed_directory, or on the command line
// with --mcp-allow <dir>.

import fs from 'fs';
import path from 'path';

class FsGuard
{
	constructor(cwd)
	{
		this.cwd = path.resolve(cwd);
		this.roots = [this.cwd];
		this._realRoots = null;
	}

	_roots()
	{
		if (this._realRoots == null)
		{
			this._realRoots = this.roots.map(root =>
			{
				try
				{
					return fs.realpathSync(root);
				}
				catch (e)
				{
					return root;
				}
			});
		}

		return this._realRoots;
	}

	_isInside(realPath)
	{
		return this._roots().some(root => realPath === root || realPath.startsWith(root + path.sep));
	}

	_resolve(p)
	{
		if (typeof p !== 'string' || p.length === 0)
		{
			throw new Error(`invalid path: ${JSON.stringify(p)}`);
		}

		const abs = path.resolve(this.cwd, p);
		let real = abs;

		try
		{
			// realpath resolves existing components (kills symlink escapes);
			// for a not-yet-existing file the deepest existing ancestor is what
			// we must check, so resolve the parent dir instead.
			real = fs.realpathSync(abs);

			if (fs.statSync(real).isDirectory())
			{
				real = abs;
			}
		}
		catch (e)
		{
			// Not a real path yet — resolve the nearest existing ancestor.
			let probe = abs;

			while (probe !== path.dirname(probe))
			{
				try
				{
					real = path.join(fs.realpathSync(probe), path.relative(probe, abs));
					break;
				}
				catch (e2)
				{
					probe = path.dirname(probe);
				}
			}
		}

		return real;
	}

	assertAllowed(p, { forWrite = false } = {})
	{
		const real = this._resolve(p);

		if (!this._isInside(real))
		{
			const roots = this.list().map(r => `  ${r}`).join('\n');
			throw new Error(`path not allowed by the MCP server: ${p}\nAllowed roots:\n${roots}`);
		}

		return real;
	}

	assertWritable(p)
	{
		const real = this.assertAllowed(p, { forWrite: true });
		const dir = path.dirname(real);

		try
		{
			fs.accessSync(dir, fs.constants.W_OK);
		}
		catch (e)
		{
			throw new Error(`directory not writable: ${dir}`);
		}

		return real;
	}

	addAllowed(dir)
	{
		const abs = path.resolve(this.cwd, dir);
		let real = abs;

		try
		{
			real = fs.realpathSync(abs);
		}
		catch (e)
		{
			// Allow adding a not-yet-existing directory, resolved when needed.
		}

		if (!this.roots.includes(real))
		{
			this.roots.push(real);
			this._realRoots = null;
		}

		return real;
	}

	removeAllowed(dir)
	{
		const abs = path.resolve(this.cwd, dir);
		let real = abs;

		try
		{
			real = fs.realpathSync(abs);
		}
		catch (e)
		{
			// fall through
		}

		const idx = this.roots.indexOf(real);

		if (idx < 0)
		{
			return false;
		}

		if (real === this.cwd)
		{
			throw new Error('the working directory root cannot be removed');
		}

		this.roots.splice(idx, 1);
		this._realRoots = null;

		return true;
	}

	list()
	{
		return [...this.roots];
	}
}

export function createFsGuard(cwd)
{
	return new FsGuard(cwd);
}
