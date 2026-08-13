// Appends build/mcp-menu-inject.js to drawio/src/main/webapp/js/diagramly/
// ElectronApp.js so the MCP menu is registered in the built-in HTML menu bar.
// Idempotent: skips if the marker line is already present.
//
// Used by the portable build workflow (before electron-builder runs) and by
// developers before `npm start`.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const injectFile = path.join(__dirname, '..', 'build', 'mcp-menu-inject.js');
const targetFile = path.join(__dirname, '..', 'drawio', 'src', 'main', 'webapp', 'js', 'diagramly', 'ElectronApp.js');

const MARKER = 'drawio-desktop mcp-menu-inject';

if (!fs.existsSync(injectFile))
{
	console.error('MCP menu inject file not found:', injectFile);
	process.exit(1);
}

if (!fs.existsSync(targetFile))
{
	console.error('ElectronApp.js not found:', targetFile);
	process.exit(1);
}

let target = fs.readFileSync(targetFile, 'utf8');

if (target.includes(MARKER))
{
	console.log('MCP menu already injected; skipping');
	process.exit(0);
}

const inject = fs.readFileSync(injectFile, 'utf8');

fs.appendFileSync(targetFile, '\n' + inject);
console.log('Injected MCP menu into', path.relative(path.join(__dirname, '..'), targetFile));
