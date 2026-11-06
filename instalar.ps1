# Instalador do Clawd Pace (chamado pelo instalar.cmd).
# Confere o Node.js, instala as dependências, garante o Electron e abre o Clawd.
# Na primeira execução o próprio app cria os atalhos (Menu Iniciar + inicialização do Windows).

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$app = $PSScriptRoot
Set-Location $app
# Terminais abertos pela extensão do VS Code herdam isto e fazem o Electron rodar como Node puro.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

function Passo($t) { Write-Host "`n> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  ok  $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "  !   $t" -ForegroundColor Yellow }
function Falha($t) { Write-Host "`n  X   $t`n" -ForegroundColor Red; Read-Host 'Enter para fechar'; exit 1 }

Write-Host '  Clawd Pace - instalador' -ForegroundColor White
Write-Host "  pasta: $app" -ForegroundColor DarkGray

# 1) Node.js
Passo 'Node.js'
function Recarregar-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Aviso 'Node.js não encontrado. Instalando a versão LTS pelo winget (pode pedir confirmação do Windows)...'
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    Recarregar-Path
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Start-Process 'https://nodejs.org/pt'
    Falha 'Instale o Node.js LTS pelo site que acabou de abrir e rode o instalar.cmd de novo.'
  }
}
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) { Falha "Node $(node -v) é antigo demais. Instale o Node.js LTS (20 ou mais novo) em nodejs.org." }
Ok "Node $(node -v)"

# 2) Dependências
Passo 'Instalando dependências (só o Electron, ~120 MB na primeira vez)'
npm install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Falha 'npm install falhou. Confira a internet e tente de novo.' }
$exe = Join-Path $app 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) {
  Aviso 'Baixando o binário do Electron...'
  node node_modules/electron/install.js
}
if (-not (Test-Path $exe)) { Falha 'Não consegui baixar o Electron.' }
Ok 'Electron pronto'

# 3) Login do Claude Code (de onde vêm os limites do plano)
Passo 'Login do Claude Code'
$cred = Join-Path $HOME '.claude\.credentials.json'
if (Test-Path $cred) {
  Ok 'Login encontrado'
} else {
  Aviso 'Não achei login do Claude Code neste PC.'
  Aviso 'O Clawd abre, mas só mostra os limites depois de instalar o Claude Code e fazer login com a conta Pro/Max.'
}

# 4) Abrir (o app cria os atalhos sozinho; se já estiver aberto, só traz o Clawd pra perto do mouse)
Passo 'Abrindo o Clawd'
Start-Process -FilePath $exe -ArgumentList "`"$app`"" -WorkingDirectory $app
Ok 'Clawd aberto. Ele vai ficar em cima da barra de tarefas e abre sozinho quando o Windows iniciar.'
Write-Host "`n  Dica: clique direito no Clawd para mudar a cor, o tamanho ou desligar a inicialização." -ForegroundColor DarkGray
Write-Host '  Não mova esta pasta depois de instalar (o atalho de inicialização aponta pra ela).' -ForegroundColor DarkGray
Start-Sleep -Seconds 6
