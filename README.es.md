# SolidWorks MCP (español)

![SolidWorks MCP: agentes de IA que modelan, ensamblan, verifican y hacen planos en SOLIDWORKS](docs/images/social_preview.png)

**Un agente de IA que modela, ensambla, verifica y hace planos en SolidWorks.** Servidor [MCP](https://modelcontextprotocol.io) para SolidWorks en Windows con 112 herramientas: piezas desde una receta corta, ensambles completos en una llamada, masa y centro de masa exactos, planos con BOM, globos y cortes, y lectura de planos PDF/DXF. Siempre con respaldos y reversión verificada: tus archivos no se rompen.

Funciona con **Claude Desktop, Claude Code, OpenAI Codex (CLI / IDE)** y cualquier cliente MCP que pueda lanzar un servidor local (stdio).

![Tablero con pivotes armado en una llamada](docs/images/pegboard_iso.png)

*Tablero con 32 componentes (4 piezas generadas desde su receta, 6 pernos, 24 pivotes por patrón circular, 23 relaciones) armado, verificado y con plano en **una** llamada de `sw_assembly_build`: masa 3864.0278 g y CM (0, 0, 13.7356) mm en 2–3 min desde cero en una laptop, incluido el arranque de SolidWorks; unos 75 s si las piezas ya existen.*

## Qué hace
- **Piezas:** `sw_part_build` arma una pieza descrita en JSON (`part-ir/1`) y la compara con su caja, volumen o masa esperados.
- **Ensambles:** `sw_assembly_build` en una llamada: piezas, relaciones por intención, tornillería ISO generada, patrones, sistemas de coordenadas deducidos del CM y verificación de relaciones, interferencias, masa y CM.
- **Planos:** vistas, escala normalizada, BOM con material y masa, globos, nota con respuestas, PDF; cortes A‑A por un punto del modelo y automáticos si una pieza interna no se ve; vista de chapa desplegada.
- **Leer planos:** de un PDF de SolidWorks, cada cota con los dos puntos de la pieza que mide; radios, diámetros y ángulos; material del cajetín. De un DXF, cotas exactas.
- **Chapa, importar/exportar:** brida base y de borde, pliegue croquizado, dobladillo, desplegado; STEP, IGES, Parasolid, ACIS, STL, PDF, DXF, DWG, en lote.
- **Seguridad:** respaldos automáticos, revisión de cada edición y reversión verificada; puede trabajar en su propio SolidWorks minimizado, aparte del tuyo.

## Instalación rápida
```powershell
git clone https://github.com/chrisncm17/solidworks-mcp.git
cd solidworks-mcp
npm install
npm run build
npm test
# o todo en una línea (requisitos, compilación, pruebas y registro en Claude Desktop, Claude Code y Codex; -WhatIf solo muestra):
# powershell -ExecutionPolicy Bypass -File install.ps1
```
Luego agrega el servidor a tu cliente (Claude Desktop, Claude Code, Codex): [docs/INSTALL.md](docs/INSTALL.md). Lista completa de herramientas y opciones: [docs/TOOLS.md](docs/TOOLS.md).

## Límites
Solo Windows. Probado con SolidWorks 2026 Educational en español. ChatGPT web/escritorio solo acepta servidores MCP remotos (HTTPS), así que este servidor local no se conecta ahí directamente.

Licencia MIT. SolidWorks es marca de Dassault Systèmes; este proyecto no está afiliado a ella.
