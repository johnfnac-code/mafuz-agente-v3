# Gabi · agente de WhatsApp da Mafuz (v4.4 · servidor 2.4.0)

Serviço Node.js (sem dependências externas) que conecta Z-API, Imoview e um modelo de linguagem.

- Passo a passo de implantação: [GUIA-DE-IMPLANTACAO.md](GUIA-DE-IMPLANTACAO.md)
- Variáveis: [.env.example](.env.example)
- Conhecimento editável: [conhecimento/casa.md](conhecimento/casa.md) e [conhecimento/mercado.md](conhecimento/mercado.md)
- Atualização para a v4.2: [ATUALIZACAO-V4.md](ATUALIZACAO-V4.md)

## Estrutura

| Arquivo | Função |
|---|---|
| `src/server.js` | Webhook da Z-API, fila por cliente, ritmo humano, cartões com foto, cutucada e follow-ups, `/site/chat`, `/site/lead` (leads do site no WhatsApp da equipe), comandos, painel `/admin` |
| `src/agent.js` | Ferramentas (buscar, enviar imóveis com foto, mercado da região, detalhar, lead, visita, corretor), roteamento venda/locação, reengajamento, chat do site |
| `src/prompt.js` | System prompt de produção com contexto dinâmico |
| `src/imoview.js` | Cliente do Imoview com lista branca de campos |
| `src/radar.js` | Radar MAFUZ: perfil de busca de cada cliente e aviso de imóvel novo compatível |
| `src/agenda.js` | Google Agenda dos corretores: horários livres (freeBusy) e reserva do evento |
| `src/video.js` | Vídeo vertical de 15 s por imóvel novo (ffmpeg, fontes Jost em `assets/fontes`) |
| `src/catalogo.js` | Carteira do Imoview em memória, sincronizada a cada 15 min e pelo webhook |
| `src/rotinas.js` | Resumo das 8h de cada corretor e pós-visita automático |
| `src/cerebro.js` | 2º Cérebro do painel: anotações da equipe e perguntas respondidas pela IA |
| `src/instagram.js` | Vídeos do Instagram da MAFUZ para o site (`/site/instagram`) |
| `src/site.js` | Link público de cada imóvel no site |
| `src/llm.js` | OpenAI ou Anthropic com chamada de ferramentas; transcrição de áudio |
| `src/zapi.js` | Envio de mensagens e configuração do webhook |
| `src/store.js` | Conversas, leads, visitas e trilha de eventos (arquivo em `DATA_DIR`) |
| `test/unidades.test.js` | Testes de radar, UTM, fotos, vídeo e agenda |
| `test/simulate.js` | Simulação ponta a ponta com Z-API e modelo falsos e Imoview real |

## Rodar localmente

```bash
cp .env.example .env   # preencha
npm start
IMOVIEW_API_KEY=... npm test
```
