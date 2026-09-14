param(
    [Parameter(Mandatory = $true)]
    [string] $ContextPath,

    [Parameter(Mandatory = $true)]
    [string] $ResultPath
)

$context = Get-Content -LiteralPath $ContextPath -Raw | ConvertFrom-Json

Write-Output "Item: $($context.item.path)"
Write-Output "ID: $($context.item.itemId)"
Write-Output "Template: $($context.item.template.name) ($($context.item.template.templateId))"
Write-Output "Language/version: $($context.item.language), v$($context.item.version)"
Write-Output "Fields: $($context.item.fields.Count)"

@{
    status = "ok"
    message = "Inspected $($context.item.path)."
} | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding utf8

exit 0
