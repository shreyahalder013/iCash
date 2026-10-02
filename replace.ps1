$old = [System.IO.File]::ReadAllText('S:\projects\icash\frontend\index.html')
$newSection = [System.IO.File]::ReadAllText('S:\projects\icash\frontend\index.html.new')
$pattern = '(?s)<!-- SCREEN: LOGIN FACE SCAN \(SERVER-AUTHORITATIVE 6-STAGE UX\) -->.*?(?=<!-- SCREEN: AADHAAR IDENTITY LOOKUP -->)'
$result = [System.Text.RegularExpressions.Regex]::Replace($old, $pattern, $newSection)
[System.IO.File]::WriteAllText('S:\projects\icash\frontend\index.html', $result)
Write-Host 'Done'