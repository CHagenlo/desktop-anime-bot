# Development-only loader. Distributed apps launch desktop-window-helper.exe directly.
# No execution policy is modified; this loader is never used by packaged builds.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $sourcePath = Join-Path $PSScriptRoot 'windows-helper.cs'
    Add-Type -Path $sourcePath -ReferencedAssemblies System.Drawing,System.Web.Extensions,System.Core -ErrorAction Stop | Out-Null
    $exitCode = [CompanionHelperProgram]::Run()
    exit $exitCode
} catch {
    [Console]::WriteLine('{"id":null,"ok":false,"error":{"code":"HELPER_START_FAILED"}}')
    [Console]::Out.Flush()
    exit 1
}
