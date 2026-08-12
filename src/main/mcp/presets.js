// Built-in style presets for restyle_diagram / create_diagram styling.
//
// Structure follows the drawio skill's preset schema (palette/roles/shapes/
// font/edges/extras). Presets can also be loaded from a JSON file path or from
// ~/.drawio-skill/styles/<name>.json (the skill's user-preset directory), so a
// preset captured by the skill can be applied through the MCP server too.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function builtInPresets()
{
	return {
		default: {
			name: 'default',
			palette: {
				primary: { fillColor: '#dae8fc', strokeColor: '#6c8ebf' },
				success: { fillColor: '#d5e8d4', strokeColor: '#82b366' },
				warning: { fillColor: '#fff2cc', strokeColor: '#d6b656' },
				accent: { fillColor: '#ffe6cc', strokeColor: '#d79b00' },
				danger: { fillColor: '#f8cecc', strokeColor: '#b85450' },
				neutral: { fillColor: '#f5f5f5', strokeColor: '#666666' },
				secondary: { fillColor: '#e1d5e7', strokeColor: '#9673a6' },
			},
			font: { fontFamily: 'Helvetica', fontSize: 12 },
			extras: { globalStrokeWidth: 1 },
		},
		dark: {
			name: 'dark',
			palette: {
				primary: { fillColor: '#004870', strokeColor: '#33b6ff' },
				success: { fillColor: '#007052', strokeColor: '#33ffc7' },
				warning: { fillColor: '#5a4916', strokeColor: '#d7b85b' },
				accent: { fillColor: '#705100', strokeColor: '#ffc633' },
				danger: { fillColor: '#502220', strokeColor: '#c4716e' },
				neutral: { fillColor: '#383838', strokeColor: '#999999' },
				secondary: { fillColor: '#3d2c45', strokeColor: '#a182b0' },
			},
			font: { fontFamily: 'Helvetica', fontSize: 12 },
			extras: {
				globalStrokeWidth: 1,
				background: '#1e1e1e',
				fontColor: '#f0f0f0',
				edgeColor: '#bbbbbb',
			},
		},
		corporate: {
			name: 'corporate',
			palette: {
				primary: { fillColor: '#e0e0f0', strokeColor: '#4a5a9a' },
				success: { fillColor: '#d6e8d6', strokeColor: '#4a8a4a' },
				warning: { fillColor: '#f7e6c8', strokeColor: '#b8860b' },
				accent: { fillColor: '#f0dcd0', strokeColor: '#c0682c' },
				danger: { fillColor: '#f0d6d6', strokeColor: '#b05050' },
				neutral: { fillColor: '#efefef', strokeColor: '#707070' },
				secondary: { fillColor: '#e8e0ea', strokeColor: '#7a5a8a' },
			},
			font: { fontFamily: 'Arial', fontSize: 12 },
			extras: { globalStrokeWidth: 1 },
		},
	};
}

export function resolvePreset(nameOrPath)
{
	const raw = String(nameOrPath);

	// A .json path is loaded verbatim (never lowercased — paths are case-sensitive).
	if (raw.endsWith('.json'))
	{
		try
		{
			return JSON.parse(fs.readFileSync(raw, 'utf8'));
		}
		catch (e)
		{
			throw new Error(`cannot load preset file '${raw}': ${e.message}`);
		}
	}

	const name = raw.toLowerCase();
	const builtIn = builtInPresets()[name];

	if (builtIn)
	{
		return builtIn;
	}

	const userDir = path.join(os.homedir(), '.drawio-skill', 'styles');
	const userPath = path.join(userDir, `${name}.json`);

	try
	{
		return JSON.parse(fs.readFileSync(userPath, 'utf8'));
	}
	catch (e)
	{
		// fall through
	}

	throw new Error(`preset '${name}' not found (built-ins: ${Object.keys(builtInPresets()).join(', ')})`);
}

export function listPresetNames()
{
	return Object.keys(builtInPresets());
}
