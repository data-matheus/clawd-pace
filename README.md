# Clawd Pace

O Clawd mora em cima da sua barra de tarefas e mostra, num olhar, **o ritmo de uso do seu plano Claude**: a sessão de 5h e o limite semanal.

Fork de [plugin87/claude-usage-pet](https://github.com/plugin87/claude-usage-pet) (MIT). O original foi auditado, a gamificação (fome, moedas, loja, quests) saiu, e o foco passou a ser o **pace**.

## Como ler

```
 5h ▕██████|░░░▏ 57% ▲      barra = quanto já usou
sem ▕████████|░▏ 75% ▲      traço branco = onde você "deveria" estar se gastasse por igual até o reset
```

| Cor / ícone | Significa |
|---|---|
| verde ✓ | no ritmo atual, você chega no reset com folga |
| âmbar ! | vai chegar perto de 100% no reset |
| vermelho ▲ | no ritmo atual, **acaba antes do reset** |
| ■ | esgotado |

O próprio Clawd também reflete o estado:

- **Calmo**: anda devagar, descansa bastante.
- **Claude trabalhando**: os logs do Claude Code estão mexendo, então ele anda mais rápido.
- **Acima do ritmo**: fica avermelhado, sua e solta fumaça, andando de um lado pro outro.
- **Esgotado**: olhos em X, com estrelinhas girando.
- **Você ausente**: depois de 10 min sem mexer no PC, ele dorme (zzz).
- **Sessão renovada**: pula e solta corações.

**Passar o mouse** mostra a frase-resumo (ex.: "5h acaba ~18:15 (reset 19:09)"). **Clicar** abre o painel com projeção, histórico, breakdown da semana (Claude Code / Cowork / Chats) e atividade local (msgs, horário de pico, ≈ valor em API). **Arrastar** pega ele no colo; ao soltar, ele cai de volta na barra. **Clique direito** abre o menu.

O ícone na bandeja mostra a % da sessão na cor do status, com uma barrinha da semana embaixo.

### Cor do Clawd

Clique direito no Clawd (ou no ícone da bandeja) > **Cor do Clawd…**. Aceita qualquer hex (`#RRGGBB` ou `#RGB`), o seletor nativo ou 16 presets, e aplica na hora. Os tons de humor (no limite, acima do ritmo, esgotado) são derivados da cor escolhida. Os olhos ficam claros sozinhos em cores escuras. "Restaurar laranja Claude" volta ao padrão `#D97757`.

## Como o pace é calculado

- **Sessão (5h)**: projeção pelo ritmo dos **últimos 30 min**. Se você parar, a projeção para junto, então só avisa quando você está queimando *agora*.
- **Semana**: projeção pela **média desde o início da semana**. "Pra chegar redondo" é quanto você pode gastar por dia daqui até o reset.
- **Alertas** (toast do Windows): sessão projetada pra estourar, sessão ≥ 90%, semana acima do ritmo (no máximo 1×/dia), semana ≥ 90%, sessão renovada.

## De onde vêm os dados

1. **Limites do plano**: o mesmo endpoint que o `/usage` do Claude Code usa (`api.anthropic.com/api/oauth/usage`), com o token OAuth em `~/.claude/.credentials.json`.
   - O token só é enviado para `api.anthropic.com`. Nunca é logado nem salvo em outro lugar.
   - O app **nunca renova o token**: renovar por fora deslogaria o Claude Code. Quando o token expira, o app espera o Claude Code renovar e atualiza na hora (vigia o arquivo).
   - Ritmo das chamadas: a cada 5 min. Quando o Claude Code está ativo, pode atualizar a cada 90 s. Se receber 429, espera de 5 a 30 min antes de tentar de novo.
2. **Statusline (opcional, tempo real)**: `statusline.js` recebe os `rate_limits` do próprio Claude Code (sem rede, sem token) e grava em `~/.claude/clawd-pace/feed.json`. Só funciona no Claude Code de terminal (a extensão do VS Code não roda statusline).
3. **Atividade local**: lê `~/.claude/projects/**/*.jsonl` numa worker thread, de forma incremental (só os bytes novos), com cache. A primeira leitura de ~1,6 GB leva ~4 s em segundo plano; depois disso, ~6 ms.

## Segurança

- Janelas com `contextIsolation`, `sandbox` e sem `nodeIntegration`. CSP `default-src 'none'`, sem nenhum script remoto. Navegação e popups bloqueados.
- Dado vindo da API entra na tela só via `textContent` (sem `innerHTML`).
- Única dependência: `electron` (`npm audit`: 0 vulnerabilidades).
- Mudanças fora desta pasta: atalho em `Inicializar` e no Menu Iniciar, estado em `%APPDATA%\Clawd Pace`, e `statusLine` em `~/.claude/settings.json` (backup em `settings.json.bak-clawd`).

## Uso

```powershell
cd C:\Users\Matheus\clawd-pace
npm install          # se o Electron não baixar: node node_modules/electron/install.js
npm start            # ou: Menu Iniciar > Clawd Pace
npm test             # testes do motor de pace e das cores
```

- **Inicia com o Windows** por padrão. Para desligar: clique direito no Clawd > "Iniciar com o Windows".
- Se rodar de dentro do terminal da extensão do VS Code e o app não abrir, a causa é a variável `ELECTRON_RUN_AS_NODE=1` herdada da extensão. Abra pelo Menu Iniciar.
- Consumo medido: ~1% de um núcleo parado/dormindo e ~6–7% andando agitado (0,8% da CPU total). Desligar "Andar pela tela" deixa sempre no mínimo.

## Desinstalar

1. Clique direito no Clawd > Sair.
2. Apague `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Clawd Pace.lnk`, `...\Programs\Clawd Pace.lnk` e `%APPDATA%\Clawd Pace`.
3. Remova a chave `statusLine` de `~/.claude/settings.json`.
4. Apague esta pasta.

## Arquivos

| Arquivo | O quê |
|---|---|
| `main.js` | janelas, caminhada, bandeja, polling, alertas, autostart |
| `pace.js` | motor de pace (puro, testado em `test/`) |
| `limits.js` | leitura dos limites do plano |
| `usage.js` + `usage-worker.js` | stats locais dos logs (worker thread) |
| `history.js` | série temporal para burn-rate e gráficos |
| `trayicon.js` | ícone da bandeja desenhado pixel a pixel |
| `color.js` | validação de hex e contraste dos olhos (testado em `test/`) |
| `statusline.js` | feed em tempo real via statusline do Claude Code |
| `renderer/pet.*` | o Clawd (SVG pixel art) + HUD |
| `renderer/panel.*` | painel de detalhes |
| `renderer/settings.*` | janela de configurações (cor) |

O Clawd é personagem da Anthropic. Este é um projeto de fã, para uso pessoal, sem afiliação com a Anthropic.
