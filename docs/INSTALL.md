# Install

## 1. Requirements

| | Why | Check |
|---|---|---|
| Windows 10/11 + SolidWorks | the worker drives SolidWorks through its COM API | SolidWorks opens normally |
| Node.js 18 or newer | runs the MCP server | `node -v` |
| .NET Framework 4.x (ships with Windows) | compiles the C# worker | `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` exists |
| Python 3.11+ with `pypdf` and `Pillow` | reading PDF/DXF drawings, images | `python -c "import pypdf, PIL"` |
| `pdftotext` (optional) | word counts in `sw_drawing_read info`; Git for Windows ships it | `where pdftotext` |

```powershell
pip install pypdf pillow
```

## 2. Build

```powershell
git clone https://github.com/chrisncm17/solidworks-mcp.git
cd solidworks-mcp
npm install
npm run build
npm test
```

`npm run build` finds the SolidWorks API in the registry (or `C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\api\redist`) and writes `server\Worker-equations.exe`. If SolidWorks is installed elsewhere set `SOLIDWORKS_API_REDIST` first:

```powershell
$env:SOLIDWORKS_API_REDIST = 'D:\SOLIDWORKS\api\redist'; npm run build
```

## 3. Register the server in your client

Use the absolute path of `server\server.mjs` (double backslashes in JSON).

### Claude Desktop
`%APPDATA%\Claude\claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "solidworks": {
      "command": "node",
      "args": ["C:\\path\\to\\solidworks-mcp\\server\\server.mjs"]
    }
  }
}
```
Restart Claude Desktop; the tools appear as `sw_*`.

### Claude Code
```powershell
claude mcp add solidworks -- node C:\path\to\solidworks-mcp\server\server.mjs
```
Optional sub-agents: copy `agents\*.md` to `%USERPROFILE%\.claude\agents\`.

### OpenAI Codex (CLI, IDE extension, desktop app)
`%USERPROFILE%\.codex\config.toml`:
```toml
[mcp_servers.solidworks]
command = "node"
args = ['C:\path\to\solidworks-mcp\server\server.mjs']
startup_timeout_sec = 60
tool_timeout_sec = 900
```

### Other MCP clients (Cursor, VS Code, Windsurf, ...)
Any client that launches a local **stdio** server works with `command: node` and the path above.

### ChatGPT
ChatGPT connectors only accept **remote** MCP servers (HTTPS). This server is local by design (it needs your SolidWorks); exposing it through a tunnel is possible but not recommended, because anyone with the URL could drive your CAD.

## 4. Timeouts
A whole assembly can take a few minutes. Codex: `tool_timeout_sec = 900`. Other clients: raise the MCP request timeout if long calls are cut.

## 5. Optional environment variables

| Variable | Default | Use |
|---|---|---|
| `SOLIDWORKS_API_REDIST` | registry / default folder | where `SolidWorks.Interop.*.dll` are (build) |
| `SW_MCP_SLDWORKS_EXE` | registry / default folder | `SLDWORKS.exe` used to start the MCP's own instance |
| `SW_DRAWING_PYTHON` | first `python` with pypdf + Pillow | Python for drawing reading |
| `SW_MCP_PDFTOTEXT` | Git's pdftotext, then PATH | pdftotext executable |
| `SW_MCP_RECIPES_DIR` | `server/recipes` | your own folder of recipe `.md` files |
| `SW_MCP_PART_HOLD` | on | `0` disables the batch hold used to speed up part building |
| `SW_MCP_BATCH_GFX` | off | `1` keeps graphics on during assembly batches (A/B timing) |
| `SW_MCP_STACK` | off | `1` adds .NET stack traces to worker errors |

## 6. First run
Ask the agent to call `sw_status`, then `sw_exam_ready {start: true}`: it starts a minimized SolidWorks that belongs to the MCP, so your own SolidWorks windows are left alone. (Without it, the worker attaches to the SolidWorks that is already running.) Everything the MCP creates goes to `server\generated\` (ignored by git).

## Updating
```powershell
git pull
npm install
npm run build   # close the MCP client first, or the old worker exe is renamed and left behind
```
