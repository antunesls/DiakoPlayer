<p align="center"><img src="brand/logo-escuro.png" alt="Igreja Diakonia Tulipas" width="420"></p>

# DiakoPlayer

Player de YouTube Music para o PC, controlado pela rede por um **app Android (APK)** ou pelo **navegador**.

Inspirado em [pear-desktop](https://github.com/pear-devs/pear-desktop) (o player e a API) e em
[ytm-remote](https://github.com/SurajBhari/ytm-remote) (o controle remoto).

```
┌──────────── PC ─────────────┐          Wi-Fi / rede local          ┌──── Celular / outro PC ────┐
│ DiakoPlayer (Electron)      │  HTTP  /api/v1/*   (porta 26538)     │ APK DiakoPlayer (WebView)  │
│  ├─ music.youtube.com       │◄────────────────────────────────────►│   ou navegador:            │
│  ├─ script injetado (player)│  WebSocket /api/v1/ws (tempo real)   │   http://IP-DO-PC:26538/   │
│  ├─ servidor HTTP + WS      │  UDP 26539 (descoberta automática)   │                            │
│  └─ serve o controle web    │                                      │                            │
└─────────────────────────────┘                                      └────────────────────────────┘
```

## Estrutura

| Pasta | O que é |
|---|---|
| `desktop/` | App Electron do PC: abre o YouTube Music, injeta o controlador (`src/inject.js`), sobe a API (`src/server.js`) e responde à descoberta UDP (`src/discovery.js`). |
| `web/` | Controle remoto (HTML/CSS/JS puro, sem build). É servido pelo PC e também vai empacotado dentro do APK. |
| `android/` | App Android nativo (Kotlin): WebView com a interface de `web/`, descoberta do PC por UDP, botões físicos de volume controlam o PC e opção de manter a tela ligada. |
| `brand/` | Logo da Igreja Diakonia Tulipas: PDF original e PNGs transparentes (escuro, claro, só o símbolo). |
| `scripts/make-brand.py` | Gera logos e todos os ícones (web, desktop, Android) a partir de `brand/logo-diakonia.pdf` (`pip install pymupdf pillow`, depois `python scripts/make-brand.py`). |

## Usar

### 1. PC
```bash
cd desktop
npm install
npm start                # roda em modo desenvolvimento
npm run dist             # gera instalador + .exe portátil em desktop/dist/
```
- Na primeira vez, faça login na sua conta do YouTube Music dentro da janela (com Premium não há anúncios; sem Premium o app clica sozinho em "Pular anúncio").
- O Windows vai perguntar sobre o firewall: **permita em redes privadas** (senão o celular não alcança o PC).
- Menu **DiakoPlayer → Conectar celular (QR code)** (ou `Ctrl+Shift+C`) mostra o endereço e o QR code.
- Fechar a janela só minimiza para a bandeja; para sair use a bandeja ou `Ctrl+Q`.
- As teclas de mídia do teclado funcionam.

### 2. Celular Android (APK)
- Instale `DiakoPlayer-remote.apk` (raiz do projeto) ou compile: `cd android && ./gradlew assembleRelease`
  → `android/app/build/outputs/apk/release/app-release.apk`.
- Abra o app no mesmo Wi-Fi: ele procura o PC sozinho. Se houver só um, conecta direto.
- Na primeira conexão aparece no PC a janela **"Um aparelho quer controlar o player"**: clique em *Permitir*.
- Os botões de volume do celular mudam o volume do PC.

### 3. Navegador (qualquer aparelho)
Abra `http://IP-DO-PC:26538/` (ou leia o QR code). No Chrome do Android dá para "Adicionar à tela inicial".

## Recursos do controle
Interface "Palco": botões grandes e alto contraste, feita para operar ao vivo.
**Baixar aos poucos** abaixa o volume até zero, pausa e devolve o volume original (3 a 12 s, ajustável nas configurações; tecla `F`; apertar de novo cancela).
Volume em blocos de 10% (toque direto) e botões −/+ de 5%. O cartão "A seguir" mostra as próximas músicas.
Tocar/pausar, anterior/próxima, ±10 s, barra de progresso arrastável, gostei/não gostei, aleatório, repetir
(desligado/todas/uma), volume e mudo, **fila** (ver, pular para uma faixa, subir/descer, remover, limpar),
**busca** no catálogo do YouTube Music (tocar agora, tocar a seguir, adicionar ao fim; aceita colar link do YouTube),
várias conexões salvas, capa desfocada de fundo, atalhos de teclado (`espaço`, `N`, `P`, `←/→`, `↑/↓`, `L`, `D`, `S`, `R`, `M`, `/`).

## Escala do louvor (DiakoHub)
O player mostra a escala do louvor e as músicas escolhidas no [DiakoHub](https://github.com/antunesls/diakohub), na aba **Culto** do controle.

1. No DiakoHub, em **/admin › Usuários e perfis**, crie um usuário com o perfil **DiakoPlayer**. Esse perfil só lê escalas e repertório e não entra no painel.
2. No PC, abra **DiakoPlayer › Integração DiakoHub** e informe o endereço do DiakoHub, o usuário e a senha. Só o PC fala com o DiakoHub. A senha fica cifrada no PC e serve apenas para renovar a sessão.
3. (Opcional) Em **/admin › DiakoPlayer** no DiakoHub, informe o endereço do controle (ex.: `http://192.168.0.20:26538`). Assim aparece o botão **Abrir no DiakoPlayer** nas músicas da escala, que abre o controle já no culto certo.

Na aba **Culto**:
- aparecem os cultos de hoje em diante, com a equipe do louvor e as músicas na ordem do ministro, cada uma com o **tom** e o BPM;
- **Montar a fila do louvor** troca a fila pelas músicas do culto e deixa a 1ª pronta e **pausada**. Nada toca até alguém apertar **Tocar** (no controle, nas teclas de mídia, na bandeja ou na janela do player). Isso vale também para os anúncios de quem não tem Premium;
- música sem link do YouTube no repertório não entra na fila e ganha um botão para buscá-la no YouTube Music;
- na tela Controle, o rótulo mostra a posição no louvor (ex.: `TOCANDO AGORA · LOUVOR 2/5 · TOM D`);
- na aba **Buscar**, a opção **Repertório da igreja** pesquisa só nas músicas aprovadas, já com o tom;
- o PC atualiza a escala a cada 5 minutos e guarda uma cópia: se o DiakoHub cair, a última escala continua aparecendo.

## API
Compatível com o plugin **API Server** do pear-desktop (`/api/v1/...`, mesmo formato de WebSocket e de autenticação
`POST /auth/{id}` → `{accessToken}`; use `Authorization: Bearer <token>`). Assim:
- o APK/web também controla um pear-desktop com o API Server ligado;
- ferramentas feitas para o pear-desktop (como o ytm-remote) funcionam com o DiakoPlayer.

Extras do DiakoPlayer: `GET /api/v1/info`, `POST /api/v1/play-song {videoId}`, o evento WebSocket `LIKE_CHANGED` e,
para o louvor, `GET /api/v1/culto` (`?refresh=1` busca de novo no DiakoHub), `GET /api/v1/repertorio` e
`POST /api/v1/queue/load {videoIds: [...]}` (troca a fila e deixa a 1ª música pausada).

Pedidos vindos do próprio PC (`localhost`) não precisam de autorização. Aparelhos autorizados ficam listados
na janela "Conectar celular", onde também dá para removê-los ou desligar a exigência de aprovação.

## Portas
- `26538/TCP`: API, WebSocket e controle web
- `26539/UDP`: descoberta automática

Configurações em `%APPDATA%/DiakoPlayer/diakoplayer-config.json`.

## Releases
Os instaladores são gerados pelo GitHub Actions (`.github/workflows/release.yml`) a cada tag `v*`:
```bash
git tag v1.0.1
git push origin v1.0.1
```
(ou em **Actions → Release → Run workflow**, informando a versão). O release recebe:
- `DiakoPlayer Setup X.Y.Z.exe` (instalador) e `DiakoPlayer-X.Y.Z-portable.exe`;
- `DiakoPlayer-Remote-X.Y.Z.apk`, assinado sempre com a mesma chave, para o Android aceitar atualizações por cima.

A chave do APK fica fora do repositório (`~/.diakoplayer-signing/`) e vai para o GitHub como *secrets*:
`bash scripts/set-release-secrets.sh`. **Guarde uma cópia dessa pasta**: sem ela, novas versões do APK
não instalam por cima das antigas.
