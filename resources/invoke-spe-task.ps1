param(
    [Parameter(Mandatory = $true)]
    [string] $ScriptPath,

    [Parameter(Mandatory = $true)]
    [string] $ContextPath,

    [Parameter(Mandatory = $true)]
    [string] $ResultPath
)

$ErrorActionPreference = "Stop"
$session = $null

function Write-TaskResult {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Status,

        [Parameter(Mandatory = $true)]
        [string] $Message
    )

    @{
        status = $Status
        message = $Message
    } | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding utf8
}

try {
    $credentialJson = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($credentialJson)) {
        throw "SPE credentials were not supplied by the extension."
    }

    $credential = $credentialJson | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($credential.username) -or
        [string]::IsNullOrWhiteSpace($credential.password)) {
        throw "SPE credentials supplied by the extension are incomplete."
    }

    $contextJson = Get-Content -LiteralPath $ContextPath -Raw
    $context = $contextJson | ConvertFrom-Json
    $serverUrl = [string] $context.connection.serverUrl
    if ([string]::IsNullOrWhiteSpace($serverUrl)) {
        throw "The selected connection does not provide a CM server URL."
    }

    $scriptText = Get-Content -LiteralPath $ScriptPath -Raw
    Import-Module -Name SPE -ErrorAction Stop

    Write-Output "Connecting to SPE at $serverUrl..."
    $session = New-ScriptSession `
        -Username ([string] $credential.username) `
        -Password ([string] $credential.password) `
        -ConnectionUri $serverUrl

    Write-Output "Validating SPE credentials..."
    $probeMarker = "__XM_CLOUD_SPE_AUTHENTICATED__$([Guid]::NewGuid().ToString('N'))"
    try {
        $probeOutput = @(Invoke-RemoteScript -Session $session -Arguments @{
            ProbeMarker = $probeMarker
        } -ScriptBlock {
            Write-Output $params.ProbeMarker
        })
    } catch {
        $probeMessage = $_.Exception.Message
        if ($probeMessage -match "Element 'Objs'.*powershell/2004/04.*was not found") {
            throw "SPE authentication failed. Sitecore rejected the supplied username or password."
        }
        throw
    }
    if (-not ($probeOutput | Where-Object { [string] $_ -eq $probeMarker })) {
        throw "SPE authentication failed or the remoting service returned no validation response."
    }
    Write-Output "SPE credentials accepted."

    $arguments = @{
        ContextJson = $contextJson
        ScriptText = $scriptText
        CompletionMarker = "__XM_CLOUD_TASK_COMPLETED__$([Guid]::NewGuid().ToString('N'))"
    }
    $remoteOutput = @(Invoke-RemoteScript -Session $session -Arguments $arguments -ScriptBlock {
        Set-Location -Path "master:"
        $taskContext = $params.ContextJson | ConvertFrom-Json
        $taskScript = [ScriptBlock]::Create([string] $params.ScriptText)
        & $taskScript -Context $taskContext
        Write-Output $params.CompletionMarker
    })

    $completed = $false
    $remoteOutput | ForEach-Object {
        if ([string] $_ -eq $arguments.CompletionMarker) {
            $completed = $true
            return
        }
        if ($_ -is [string]) {
            Write-Output $_
        } else {
            Write-Output ($_ | Out-String).TrimEnd()
        }
    }
    if (-not $completed) {
        if ($remoteOutput.Count -eq 0) {
            throw "SPE authentication failed or the remoting service returned no response."
        }
        throw "The remote SPE task did not confirm successful completion. Review the preceding task output."
    }
    Write-TaskResult -Status "ok" -Message "SPE task completed successfully."
    exit 0
} catch {
    $message = $_.Exception.Message
    [Console]::Error.WriteLine($message)
    Write-TaskResult -Status "error" -Message $message
    if ($message -match "(?i)\b401\b|unauthori[sz]ed|authentication failed") {
        exit 41
    }
    if ($message -match "(?i)\b403\b|forbidden|access denied") {
        exit 42
    }
    exit 1
} finally {
    if ($null -ne $session) {
        Stop-ScriptSession -Session $session -ErrorAction SilentlyContinue
    }
}
