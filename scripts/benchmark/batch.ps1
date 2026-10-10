# Runs one unattended benchmark batch on Windows against a local model server
# (docs/plans/benchmark-runs.md). Keeps the PC awake while it runs, starts the server if it
# is not answering, runs each step of main.ts in order, and logs everything to
# <Work>\batches\<date>-<time>.log, ending with `status`.
#
#   batch.ps1 -Steps "run --harness claude --arms none --reps 1 --stop-at 06:30; annotate --repo click"
#
# Each step is a main.ts command line without --work, --model, and --provider, which come
# from the parameters; steps are split on ";" and words on spaces, so no step may hold a
# quote. A step that fails ends the batch. While it runs, <Work>\batch.pid holds its process
# id, and a second batch refuses to start.
param(
    [Parameter(Mandatory)][string]$Steps,
    [string]$Work = 'C:\cb',
    [string]$Model = 'qwen3.8-flash-next-iq2_xs',
    [string]$Provider = 'http://127.0.0.1:8411',
    [string]$StartServer = 'F:\AI\llama-serve\start-strata.ps1',
    [int]$ServerWaitMinutes = 10
)
$ErrorActionPreference = 'Stop'

$Repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Main = Join-Path $Repo 'scripts\benchmark\main.ts'
New-Item -ItemType Directory -Force (Join-Path $Work 'batches') | Out-Null
$Log = Join-Path $Work ("batches\{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmm'))

function Write-Log([string]$Line) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Line" | Out-File -Append -Encoding utf8 $Log
}

# ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no sleep while this thread lives. The display may still turn off.
Add-Type -Namespace Bench -Name Power -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
'@
[Bench.Power]::SetThreadExecutionState([uint32]'0x80000001') | Out-Null

function Test-Server {
    try {
        return (Invoke-WebRequest -Uri "$Provider/v1/models" -TimeoutSec 10 -UseBasicParsing).StatusCode -eq 200
    } catch {
        return $false
    }
}

# One batch at a time: the model server serves one request at a time.
$PidFile = Join-Path $Work 'batch.pid'
if (Test-Path $PidFile) {
    $other = Get-Process -Id ([int](Get-Content $PidFile)) -ErrorAction SilentlyContinue
    if ($other -and $other.ProcessName -eq 'pwsh') {
        Write-Log "refused: batch process $($other.Id) is still running"
        exit 1
    }
}
Set-Content -Path $PidFile -Value $PID

# main.ts reads benchmark\tasks.json relative to the repository.
Push-Location $Repo
try {
    Write-Log "batch on branch $(git -C $Repo rev-parse --abbrev-ref HEAD) at $(git -C $Repo rev-parse --short HEAD): $Steps"
    npm run build --prefix $Repo *>&1 | Out-File -Append -Encoding utf8 $Log
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }

    if (-not (Test-Server)) {
        Write-Log "starting the model server with $StartServer"
        Start-Process pwsh -WindowStyle Minimized -ArgumentList '-NoProfile', '-File', $StartServer
        $deadline = (Get-Date).AddMinutes($ServerWaitMinutes)
        while (-not (Test-Server)) {
            if ((Get-Date) -gt $deadline) { throw "the model server did not answer within $ServerWaitMinutes minutes" }
            Start-Sleep -Seconds 10
        }
    }
    Write-Log 'model server is answering'

    foreach ($step in $Steps -split ';') {
        $stepArgs = @($step.Trim() -split '\s+') + @('--work', $Work, '--model', $Model, '--provider', $Provider)
        Write-Log "step: node scripts\benchmark\main.ts $($stepArgs -join ' ')"
        node $Main @stepArgs *>&1 | Out-File -Append -Encoding utf8 $Log
        if ($LASTEXITCODE -ne 0) { throw "step failed with exit code ${LASTEXITCODE}: $step" }
    }
} catch {
    Write-Log "batch stopped: $_"
} finally {
    foreach ($harness in 'claude', 'pi') {
        node $Main status --work $Work --harness $harness *>&1 | Out-File -Append -Encoding utf8 $Log
    }
    Write-Log 'batch ended'
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Pop-Location
    [Bench.Power]::SetThreadExecutionState([uint32]'0x80000000') | Out-Null
}
