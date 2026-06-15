@echo off
REM Generic browser-automation MCP (server name "browser"). Isolated from the bas-k
REM accounting browser: own CDP port (9333) + profile dir, headless by default.
REM Use for general browsing/screenshotting without touching the accounting session.
cd /d D:\web-auto
if "%GENERIC_HEADLESS%"=="" set GENERIC_HEADLESS=1
npx ts-node core\src\mcp-generic.ts
