# Atualização da Gabi · versão 4.4 (servidor 2.4.0)

Tempo estimado: 20 minutos. Nada muda no número de WhatsApp nem na Z-API.

## O que muda na 4.4 (servidor 2.4.0)

- **Carteira inteira, sempre.** A sincronização refaz as páginas que o Imoview recusar (limite de requisições) até fechar a conta com o total do CRM. O `/health` mostra `carteira`, `carteira_no_imoview` e `carteira_completa`.
- **Busca por lugar do jeito que o cliente fala.** Todo bairro e condomínio com imóvel publicado é reconhecido, mesmo com erro de digitação, cidade trocada ("Vila da Serra em BH") ou cidade no lugar do bairro. Regiões: Seis Pistas, Zona Sul, Oeste, Pampulha, Vetor Sul, Vetor Norte, Lagoa dos Ingleses, Serra do Cipó e Trancoso. Sem imóvel no bairro, sugere os vizinhos antes da cidade inteira.
- **Link exato.** Todo imóvel vai com a página dele no site (`mafuz.site/imovel/<id>`); imóvel que acabou de entrar no CRM vai como `mafuz.site/imovel/<código>`, que o site 2.4.2 abre direto na ficha.
- Busca por código acha o imóvel mesmo que a finalidade venha trocada e, se ele entrou no CRM depois da última carga, consulta o Imoview na hora.

## Por que o /health ainda mostra 1.0.0

A Gabi que conversa no WhatsApp foi atualizada pelo prompt, mas o **servidor** que roda na Railway é o arquivo `src/server.js` do repositório. Se `/health` mostra `1.0.0`, a Railway está publicando a versão antiga desse arquivo. As duas causas mais comuns:

1. **Pasta dentro de pasta.** O zip abre como `mafuz-agente/src/...`. Arrastar a pasta `mafuz-agente` inteira cria `mafuz-agente/mafuz-agente/src` no GitHub, e a Railway continua lendo o `src` antigo da raiz.
2. **Upload parcial.** Só alguns arquivos foram enviados e `src/server.js` ficou na versão antiga.

Como conferir: no GitHub, abra `src/server.js` **na raiz** do repositório e procure `VERSAO`. Tem que estar `'2.4.0'`.

## Passo 1 · GitHub (repositório `mafuz-agente`)

1. Descompacte `mafuz-agente-v4.2.zip` no computador.
2. **Entre** na pasta `mafuz-agente` que foi criada.
3. No GitHub: **Add file › Upload files** e arraste **o conteúdo** dela: as pastas `src`, `assets`, `conhecimento`, `test`, `site-extras` e os arquivos `Dockerfile`, `package.json`, `README.md`, `.env.example`, `ATUALIZACAO-V4.md`, `GUIA-DE-IMPLANTACAO.md`.
4. Mensagem do commit: `Gabi v4.2`. **Commit changes**.
5. Se existir uma pasta `mafuz-agente/` dentro do repositório (de um upload anterior), apague-a: abra a pasta › `...` › **Delete directory**.

A Railway publica em 2 a 4 minutos (esta versão instala o `ffmpeg` para os vídeos).

## Passo 2 · Railway › Variables

Obrigatórias nesta versão:

| Variável | Valor |
|---|---|
| `PUBLIC_URL` | `https://mafuz-agente-production.up.railway.app` (endereço dos vídeos) |
| `SITE_CHAT_ORIGINS` | `https://mafuz.site,https://www.mafuz.site,https://SEU-SITE.netlify.app` |

Agenda do Google (horários livres de verdade):

| Variável | Valor |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | JSON inteiro da conta de serviço (Passo 4) |
| `AGENDA_CORRETORES` | `5531989097232=marcella@mafuz.com.br,5531988093993=thais@mafuz.com.br,...` (telefone=e-mail da agenda) |

Opcionais, já com o valor certo no código:

| Variável | Padrão | O que faz |
|---|---|---|
| `CATALOGO_SYNC_MIN` | `15` | Recarrega a carteira do Imoview a cada 15 min |
| `RADAR` | `true` | Avisa clientes quando entra imóvel que combina com a busca deles |
| `RADAR_INTERVALO_HORAS` / `RADAR_MAX_IMOVEIS` / `RADAR_VALIDADE_DIAS` | `20` / `2` / `60` | Intervalo mínimo entre avisos, imóveis por aviso, validade do perfil |
| `VIDEO_AUTOMATICO` | `true` | Gera vídeo vertical de 15 s para cada imóvel novo |
| `VIDEO_NO_WHATSAPP` | `true` | Envia o vídeo no lugar da foto quando ele existe |
| `VIDEO_MAX_POR_CICLO` | `6` | Vídeos gerados por ciclo, para não pesar o servidor |
| `UTM_LINKS` | `true` | Links para o site saem com `utm_source=whatsapp&utm_medium=gabi` |
| `VISITA_DURACAO_MIN` / `AGENDA_DIAS` | `60` / `7` | Duração da visita e quantos dias à frente oferecer |
| `SITE_SUPABASE_URL` / `SITE_SUPABASE_ANON_KEY` | projeto atual do site | Troque quando o Supabase próprio da MAFUZ estiver no ar |

## Passo 3 · Webhook do Imoview (carteira ao vivo)

No Imoview, em *Configurações › Integrações › Webhook*, cadastre:

```
https://mafuz-agente-production.up.railway.app/webhook/imoview?secret=SEU_WEBHOOK_SECRET
```

Cada cadastro ou alteração no Imoview faz a Gabi recarregar a carteira em segundos. Os 15 minutos continuam como garantia.

## Passo 4 · Google Agenda dos corretores

1. [console.cloud.google.com](https://console.cloud.google.com) › projeto novo `mafuz-agenda` › ative a **Google Calendar API**.
2. *IAM › Contas de serviço* › **Criar** `gabi-agenda` › *Chaves* › **Adicionar chave › JSON**. Baixa um arquivo.
3. Cada corretor, no Google Agenda dele: *Configurações da agenda › Compartilhar com pessoas específicas* › adiciona o e-mail da conta de serviço com **Fazer alterações nos eventos**.
4. Na Railway, cole o conteúdo do JSON em `GOOGLE_SERVICE_ACCOUNT_JSON` e preencha `AGENDA_CORRETORES`.

Com isso a Gabi oferece só horários em que o corretor da carteira está livre e cria o evento na agenda dele ao confirmar. Sem essas variáveis ela volta a perguntar o melhor dia e horário, como antes.

## Passo 5 · Conferir em 2 minutos

1. `…/health` mostra `"versao": "2.4.0"`, `sincroniza_a_cada_min: 15`, `radar`, `agenda_google` e `videos`.
2. `…/admin/funil?token=SEU_ADMIN_TOKEN`: origem dos leads, tempo de resposta e conversão por corretor.
3. `…/admin/videos?token=SEU_ADMIN_TOKEN`: vídeos gerados. Para gerar um: `&gerar=CODIGO`.
4. `…/admin/radar?token=SEU_ADMIN_TOKEN`: prévia de quem receberia aviso. **Só** com `&enviar=1` envia de verdade.
5. No WhatsApp, `#status` mostra as linhas do radar e dos vídeos.

## O que mudou nesta versão

| Recurso | Como funciona |
|---|---|
| Carteira ao vivo | Sincroniza a cada 15 min e no webhook do Imoview; registra imóveis novos e baixas |
| Radar MAFUZ | Guarda o perfil de busca de cada cliente e avisa quando entra um imóvel compatível (preço com 10% de tolerância), no máximo 1 aviso a cada 20 h, dentro da janela de envio |
| Agenda real | Ferramenta `horarios_livres` lê a agenda do corretor da carteira e reserva o evento |
| Vídeo de 15 s | 1080×1920 com as fotos do Imoview, dados do imóvel e cartão final; enviado no WhatsApp |
| Origem do lead | Site, Instagram, anúncio, ficha de imóvel, portal ou WhatsApp direto, registrada em cada conversa |
| Tempo de resposta | Mede quanto a equipe levou para responder depois do encaminhamento |
| Conversas no painel | Rotas `/painel/*` alimentam a aba **Conversas** do painel do site: todos veem e respondem pelo número da MAFUZ |
| Mensagens do site | Links do site abrem o WhatsApp com texto pronto ("Vim pelo site da Mafuz… Código: X"); a Gabi entende e já responde sobre o imóvel |

## Novidades da 4.3

| Recurso | Como funciona | Variáveis |
|---|---|---|
| Resumo das 8h | De segunda a sábado, às 8h, cada corretor recebe no WhatsApp as visitas do dia, os clientes esperando retorno e os imóveis novos da carteira dele | `RESUMO_8H`, `RESUMO_HORA`, `RESUMO_DIAS`, `NOMES_CORRETORES` |
| Pós-visita | 2 h depois de uma visita confirmada pela equipe, a Gabi pergunta ao cliente como foi (nota de 1 a 5). A resposta vai para o corretor e, se a nota for baixa, ela oferece alternativas | `POS_VISITA`, `POS_VISITA_HORAS` |
| 2º Cérebro | Chat do painel (Inteligência) responde com os números do site, das conversas e das anotações da equipe | usa a mesma chave da OpenAI |
| Instagram no site | Vídeos de @mafuzimoveisdeluxo aparecem na home e em Sobre | `INSTAGRAM_TOKEN` |

Prévias sem enviar nada: `…/admin/resumo?token=SEU_ADMIN_TOKEN` e `…/admin/posvisita?token=SEU_ADMIN_TOKEN`.
Com `&enviar=1` envia de verdade.

## Voltar para a versão anterior

Railway › *Deployments* › deploy anterior › **Redeploy**. As conversas continuam no volume `/app/data`.

## Testes automáticos

`npm run test:unidades` roda radar, UTM, fotos, vídeo de 15 s e agenda. `IMOVIEW_API_KEY=… npm test` roda também a simulação ponta a ponta.
