// Write-review staging area.
//
// This is the heart of the "写入审查" (write review) mechanism. Every mutating
// MCP tool writes to an in-memory pending slot for the target file instead of
// touching the disk. Nothing reaches the filesystem until the client calls
// commit_changes, which re-runs the structural lint and (optionally) verifies
// the file was not modified behind our back. discard_changes abandons the
// staged work; review_pending_changes returns the pending diff for the client
// (or the human) to approve.
//
// A pending slot records the original file content (used as the optimistic
// concurrency baseline), the staged content, and a human-readable operation
// log that explains what changed.

import { createHash } from 'crypto';
import fs from 'fs';

export function hashContent(text)
{
	return createHash('sha256').update(text).digest('hex');
}

export class StagingArea
{
	constructor()
	{
		this._slots = new Map();
	}

	has(path)
	{
		return this._slots.has(path);
	}

	get(path)
	{
		return this._slots.get(path) || null;
	}

	// Stage a full new version of the file.
	//   path       resolved absolute path of the target file
	//   staged     new content (the write that is pending review)
	//   ops        [{op, summary}] human-readable change log entries
	// Returns the pending slot.
	set(path, staged, ops = [])
	{
		const existing = this._slots.get(path);
		const original = existing ? existing.original : (existingCurrent(path) || '');

		const slot = {
			path,
			original,
			originalEtag: hashContent(original),
			staged,
			stagedEtag: hashContent(staged),
			ops: existing ? [...existing.ops, ...ops] : ops,
			createdAt: existing ? existing.createdAt : new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			hasOriginalOnDisk: existing ? existing.hasOriginalOnDisk : fileExists(path),
		};

		this._slots.set(path, slot);

		return slot;
	}

	// Content currently staged for path, or null when nothing is pending.
	stagedContent(path)
	{
		const slot = this._slots.get(path);

		return slot ? slot.staged : null;
	}

	appendOps(path, ops)
	{
		const slot = this._slots.get(path);

		if (slot)
		{
			slot.ops.push(...ops);
			slot.updatedAt = new Date().toISOString();
		}
	}

	remove(path)
	{
		this._slots.delete(path);
	}

	list()
	{
		return [...this._slots.values()];
	}

	count()
	{
		return this._slots.size;
	}

	// Verify the on-disk file still matches what we staged on top of.
	// Returns an error string when the file changed under us (concurrent edit).
	checkBaseline(path)
	{
		const slot = this._slots.get(path);

		if (!slot) return null;

		if (slot.hasOriginalOnDisk)
		{
			try
			{
				const now = fileExists(path) ? readContent(path) : null;

				if (hashContent(now || '') !== slot.originalEtag)
				{
					return 'the file was modified on disk after it was staged; ' +
						'discard the pending changes and re-stage to review the new base';
				}
			}
			catch (e)
			{
				return `could not verify the on-disk baseline: ${e.message}`;
			}
		}
		else if (fileExists(path))
		{
			return 'the file now exists on disk, but the staged changes were created for a new file';
		}

		return null;
	}
}

function fileExists(p)
{
	try
	{
		return fs.statSync(p).isFile();
	}
	catch (e)
	{
		return false;
	}
}

function readContent(p)
{
	return fs.readFileSync(p, 'utf8');
}

function existingCurrent(p)
{
	try
	{
		return readContent(p);
	}
	catch (e)
	{
		return '';
	}
}
