$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodePath = if ($nodeCommand) { $nodeCommand.Source } elseif (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { throw 'Node.js 24+ was not found. Install Node.js, or run this on the computer that has the Codex bundled runtime.' }
$version = [Version]((& $nodePath --version).TrimStart('v'))
if ($version.Major -lt 24) { throw 'CampusIQ local backend requires Node.js 24 or newer.' }
Write-Host 'Starting CampusIQ. The server will show its active address below; keep this window open while using it.'
& $nodePath (Join-Path $PSScriptRoot 'server.js')
