# draw.io MCP Server

draw.io Desktop can act as a **Model Context Protocol (MCP)** server, letting
an LLM agent read, create, edit, validate, restyle, export and layout
`.drawio` diagram files on your machine. The server is built around the
write-review mechanism used by the official draw.io skill: every mutation is
staged in memory, structurally linted, and only written to disk after an
explicit review + approval step. Nothing touches your diagrams without your
consent.

- Transport: **stdio** (default, recommended for most MCP clients) or
  **Streamable HTTP**.
- File access: restricted to the process working directory plus any extra
  directories you explicitly allow.
- Export / layout: reuses the draw.io CLI (`drawio -x ...`), or the
  `drawio` binary found on `PATH`.

## Enabling the server

Run the app (or the server entry point directly) with `--mcp`:

```
drawio --mcp                                # stdio transport (default)
drawio --mcp --mcp-transport http --mcp-port 8890
drawio --mcp --mcp-readonly                 # read-only: every write tool is disabled
```

Headless / development use (no Electron UI):

```
node src/main/mcp-server.js --mcp
node src/main/mcp-server.js --mcp --mcp-transport http --mcp-host 0.0.0.0 --mcp-port 8890
```

### Command-line flags

| Flag | Meaning |
|------|---------|
| `--mcp` | Start the MCP server (stdio transport unless overridden) |
| `--mcp-transport <stdio\|http>` | Transport selection (default `stdio`) |
| `--mcp-port <port>` | HTTP port (default `8890`) |
| `--mcp-host <host>` | HTTP bind address (default `127.0.0.1`) |
| `--mcp-readonly` | Disable every mutating tool (review/commit included) |
| `--mcp-allow <dir>` | Allow an extra directory for file access (repeatable) |
| `--mcp-autocommit` | Commit staged changes immediately, skipping write review |

### Environment variables

| Variable | Meaning |
|----------|---------|
| `DRAWIO_MCP_TRANSPORT` | Transport, overrides the CLI flag |
| `DRAWIO_MCP_HOST` / `DRAWIO_MCP_PORT` | HTTP bind settings |
| `DRAWIO_MCP_READONLY` | `true` = read-only mode |
| `DRAWIO_MCP_AUTOCOMMIT` | `true` = auto-commit |
| `DRAWIO_MCP_NO_STAGING` | `true` = bypass write review (every write hits the disk at once; dangerous) |
| `DRAWIO_MCP_DRAWIO_BIN` | Path to a `drawio` CLI binary for export/layout |
| `DRAWIO_MCP_EXPORT_TIMEOUT_MS` | Per-export timeout (default `120000`) |

## The write-review workflow

This is the security core of the server and mirrors the official draw.io
skill. Four tools implement it:

1. **`edit_diagram` / `create_diagram` / `restyle_diagram` / `relabel_diagram` / `apply_layout`**
   mutate an in-memory copy of the diagram and place the new version in the
   **staging area**. The file on disk is never touched.
2. **`validate_diagram`** runs a deterministic structural lint over the staged
   content — dangling edge endpoints, duplicate or reserved ids, broken parent
   references, and (as warnings) off-grid geometry, sibling overlaps and
   edge-routing defects — plus a readability score.
3. **`review_pending_changes`** shows every pending change with its operation
   log, a structural diff against the on-disk file, and the validation report.
4. **`commit_changes`** is the *only* tool that writes a diagram file. Before
   writing it re-validates the staged content and verifies the file was not
   changed on disk after staging (optimistic concurrency, so a concurrent
   human edit is never silently overwritten). Validation errors block the
   commit unless `force: true` is passed.

```
agent                    server (memory)                    disk
  |  edit_diagram (addVertex, addEdge, ...)  |
  |------------------------------------------>|
  |  validate_diagram                         |           (nothing written)
  |  review_pending_changes                   |
  |------------------------------------------>|
  |  commit_changes (validates + re-checks)   |
  |------------------------------------------>|----------> write file
```

Use `discard_changes` to drop a pending edit without writing anything.

## Tools (22)

### Session & file policy

| Tool | Purpose |
|------|---------|
| `session_info` | Server state: version, mode, allowed directories, pending count, CLI availability |
| `list_allowed_directories` | Show the sandbox roots |
| `add_allowed_directory` | Grant an extra directory for read/write |
| `remove_allowed_directory` | Revoke an extra directory |

### Reading

| Tool | Purpose |
|------|---------|
| `read_diagram` | Raw `.drawio` XML (staged content when pending) |
| `get_diagram_info` | Page/shape/edge counts and file metadata |
| `describe_diagram` | Human-readable Markdown summary of pages, shapes and connections |
| `diff_diagrams` | Structural diff between two files (by id, or by visible label) |
| `extract_labels` | Identity `{label: label}` map, ready for translation |

### Writing (all staged for review)

| Tool | Purpose |
|------|---------|
| `create_diagram` | New empty diagram, or from `initialXml` |
| `edit_diagram` | Batch of targeted edit operations (14 op kinds, below) |
| `apply_layout` | Re-layout via the draw.io CLI: `verticalFlow`, `horizontalFlow`, `verticalTree`, `horizontalTree`, `radialTree`, `organic` |
| `restyle_diagram` | Re-theme with a preset palette (built-in, JSON file, or `~/.drawio-skill/styles/<name>.json`) |
| `relabel_diagram` | Bulk swap labels via a `{old: new}` map |

`edit_diagram` accepts an array of operations:

| Operation | Description |
|-----------|-------------|
| `setLabel` | Change a cell's text |
| `setStyleProperty` | Set/remove one style key (`value: null` removes it) |
| `setStyle` | Replace the whole style string |
| `setColor` | Set `fill` / `stroke` / `font` colors at once |
| `addVertex` | Add a shape (optionally `id`, `parent`, `style`) |
| `addEdge` | Add a connection (`source`/`target` cell ids must exist) |
| `removeCell` | Remove a shape (referencing edges are removed too) |
| `moveCell` | Move to an absolute position |
| `resizeCell` | Resize |
| `setEdgeWaypoints` | Set explicit routing points |
| `addPage` / `removePage` / `renamePage` | Page management |

### Write review

| Tool | Purpose |
|------|---------|
| `validate_diagram` | Structural lint (errors, warnings, readability score) |
| `review_pending_changes` | Full pending-change report (ops, diff, validation) |
| `commit_changes` | **The only** write-to-disk tool (re-validates + concurrency check; `force` overrides) |
| `discard_changes` | Drop pending changes |

### Output

| Tool | Purpose |
|------|---------|
| `export_diagram` | Render to `png` / `svg` / `pdf` / `jpg` / `xml` / `html` via the draw.io CLI |
| `preview_diagram` | Export a width-capped PNG draft (default 2000px) for visual self-check; returns the output path |
| `open_in_app` | Open the file in the draw.io Desktop UI |

## Resources

- `drawio://server/info` — static server info
- `drawio://diagram/{path}` — the diagram XML (staged content when pending)
- `drawio://diagram/{path}/pages/{page}` — a single page of the diagram

## Prompts

- `review-diagram` — review an existing diagram against a checklist
- `create-diagram` — build a diagram from a natural-language brief
- `write-review-policy` — explains the write-review rules to the agent

## File-access sandbox

Every path a tool touches (read or write) must resolve inside an allowed
directory, real-pathed so symlinks cannot escape the sandbox. Allowed roots:

- the process working directory (always),
- anything added with `--mcp-allow <dir>` or the `add_allowed_directory` tool.

Anything else is rejected with a clear list of the allowed roots.

## Presets

`restyle_diagram` accepts:

- a built-in name — `default`, `dark`, `corporate`,
- a path to a JSON preset file, or
- a user preset at `~/.drawio-skill/styles/<name>.json`.

A preset is:

```json
{
  "palette": {
    "primary":   {"fillColor": "#2878B5", "strokeColor": "#1A4E7A"},
    "success":   {"fillColor": "#82B366", "strokeColor": "#4E7A32"},
    "warning":   {"fillColor": "#FFC759", "strokeColor": "#B08C1F"},
    "accent":    {"fillColor": "#F08E4A", "strokeColor": "#B06020"},
    "danger":    {"fillColor": "#B85450", "strokeColor": "#8A3B38"},
    "neutral":   {"fillColor": "#F5F5F5", "strokeColor": "#666666"},
    "secondary": {"fillColor": "#9673A6", "strokeColor": "#6E5480"}
  },
  "font": {"fontFamily": "Helvetica", "fontSize": "12"},
  "extras": {
    "fontColor": "#1D1D1D",
    "edgeColor": "#333333",
    "background": "#FFFFFF",
    "globalStrokeWidth": 2,
    "sketch": false
  }
}
```

Vertex fills are remapped to the palette slot with the closest hue
(grey/very light/very dark fills map to `neutral`). `fillColor=none` is
structural and is never replaced; edge-routing style keywords are untouched.

## Client configuration examples

### Claude Desktop

```json
{
  "mcpServers": {
    "drawio": {
      "command": "/Applications/draw.io.app/Contents/MacOS/draw.io",
      "args": ["--mcp", "--mcp-allow", "/path/to/your/diagrams"]
    }
  }
}
```

### Generic MCP client over HTTP

```
POST http://127.0.0.1:8890/mcp
```

The HTTP endpoint follows the MCP Streamable HTTP spec: the first request
creates a session, responses carry the `Mcp-Session-Id` header that subsequent
requests must echo. Idle sessions are reaped after 30 minutes.

## Troubleshooting

- **`draw.io CLI not found`** on export/layout — install draw.io Desktop, or
  point `DRAWIO_MCP_DRAWIO_BIN` at the binary.
- **`no display available and xvfb-run not found`** on Linux — install `xvfb`
  so headless export can run.
- **`path not allowed by the MCP server`** — grant the directory with
  `--mcp-allow` or `add_allowed_directory`.
- **`commit_changes` refuses to write** — the staged content has validation
  errors (read the report, fix with `edit_diagram`, or pass `force: true`), or
  the on-disk file changed after staging (use `discard_changes` and re-stage).

## Tests

The MCP modules have unit and end-to-end coverage in `src/test/`
(`mcp-*.test.js`), run with `npm test`. The end-to-end test drives a real
server over stdio and exercises the full write-review lifecycle.
