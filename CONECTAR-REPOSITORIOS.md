# Versão final · conectar os dois repositórios novos

Dois pacotes, dois repositórios, dois serviços:

| Pacote | Repositório novo | Publica em | Versão |
|---|---|---|---|
| `mafuz-site-final.zip` | `mafuz-site` | Netlify → mafuz.site | site 2.4.2 |
| `mafuz-agente-final.zip` | `mafuz-agente` | Railway → Gabi no WhatsApp | servidor 2.4.0 |

Tempo total: cerca de 40 minutos. Nada sai do ar durante a troca: os serviços continuam rodando a versão atual até você apontar para os repositórios novos. Não apague os repositórios antigos até conferir tudo (passo 6).

## 1 · Preparar

1. Instale o [GitHub Desktop](https://desktop.github.com) e entre com a sua conta do GitHub.
2. Descompacte os dois pacotes. Ficam duas pastas: `mafuz-site` e `mafuz-agente`, cada uma com `package.json` na raiz.

Os pacotes vêm sem histórico antigo de propósito: o histórico anterior tinha senhas em arquivos de configuração, e um repositório novo começa limpo.

## 2 · Criar os repositórios e enviar o código

Faça para cada pasta (primeiro `mafuz-agente`, depois `mafuz-site`):

1. GitHub Desktop › **File › Add local repository** › escolha a pasta.
2. Ele avisa que a pasta ainda não é um repositório: clique em **create a repository**. Nome igual ao da pasta, **Git ignore: None**, **Create repository**.
3. Na caixa de commit (canto inferior esquerdo), escreva `Versão final` e clique **Commit to main**.
4. **Publish repository** › deixe **Keep this code private** marcado › **Publish**.
5. Confira no GitHub: na raiz aparecem `package.json` e a pasta `src` (e o `Dockerfile`, no agente).

Pelo terminal, se preferir (dentro de cada pasta; na última linha, troque `mafuz-site` pelo nome da pasta):

```
git init -b main
git add .
git commit -m "Versão final"
gh repo create mafuz-site --private --source . --push
```

## 3 · Agente na Railway

1. Railway › projeto da Gabi › serviço `mafuz-agente` › **Settings › Source**.
2. **Disconnect** do repositório antigo e **Connect Repo** › `mafuz-agente` › branch `main`. Root Directory vazio.
3. As **Variables** e o **Volume** (`/app/data`, onde ficam as conversas) continuam no serviço: nada se perde.
4. Em **Variables**, confira ou crie:

| Variável | Valor |
|---|---|
| `SITE_URL` | `https://mafuz.site` |
| `SITE_CHAT_ORIGINS` | `https://mafuz.site,https://www.mafuz.site,https://SEU-SITE.netlify.app` |
| `PUBLIC_URL` | `https://mafuz-agente-production.up.railway.app` |
| `INSTAGRAM_TOKEN` | token do Instagram (passo 7), opcional |
| `GOOGLE_SERVICE_ACCOUNT_JSON` e `AGENDA_CORRETORES` | agenda real dos corretores, opcional |

O resumo das 8h e o pós-visita já vêm ligados, com os nomes dos cinco corretores.

5. Aguarde o deploy (2 a 4 minutos) e abra `https://mafuz-agente-production.up.railway.app/health`. Tem que mostrar `"versao": "2.4.0"`, `resumo_8h`, `pos_visita`, `cerebro` e `instagram`.

## 4 · Site na Netlify

1. Netlify › site da MAFUZ › **Site configuration › Build & deploy › Continuous deployment › Manage repository › Link to a different repository**.
2. GitHub › `mafuz-site` › branch `main`. Build (`npm run build`) e pasta (`dist`) vêm do `netlify.toml`.
3. **Environment variables**: as públicas (Supabase, Maps e endereço da Gabi) já estão no `netlify.toml`. Crie só as que ligam recursos:

| Variável | Para quê |
|---|---|
| `VITE_GA4_ID` | Google Analytics 4 |
| `VITE_META_PIXEL_ID` | Meta Pixel |
| `VITE_GOOGLE_CLIENT_ID` | botão Conectar Google Agenda no painel |

4. **Deploys › Trigger deploy › Deploy site**.

**Sem GitHub (arrastar e soltar):** funciona, desde que você envie a pasta **pronta**, não o código. Use o pacote `mafuz-site-netlify-pronto.zip`: descompacte e arraste a pasta `dist` em **Deploys › Drag and drop**. Nesse modo o site não se atualiza sozinho: cada mudança pede uma pasta nova, e GA4, Meta Pixel e Google Agenda só entram se forem colocados antes de gerar a pasta.

Se o endereço da Railway mudar algum dia, troque `VITE_GABI_CHAT_URL` no `netlify.toml` (é ele que liga o chat do site, a aba Conversas, o 2º Cérebro e o Instagram ao agente).

## 5 · As pontas que ligam site e agente

| Onde | O quê | Por quê |
|---|---|---|
| Netlify (`netlify.toml`) | `VITE_GABI_CHAT_URL` = `https://mafuz-agente-production.up.railway.app/site/chat` | chat do site, Conversas, 2º Cérebro, Instagram |
| Railway | `SITE_CHAT_ORIGINS` com todos os endereços do site | sem isso o navegador bloqueia as chamadas |
| Railway | `SITE_SUPABASE_URL` e `SITE_SUPABASE_ANON_KEY` (padrão: projeto atual) | o agente confere o login do painel |
| Imoview | webhook `https://mafuz-agente-production.up.railway.app/webhook/imoview?secret=SEU_WEBHOOK_SECRET` | carteira atualiza na hora |
| Supabase › Authentication › URL Configuration | Site URL `https://mafuz.site` e Redirect URLs do domínio | e-mails de login levam ao site certo |

A confirmação de visita pelo corretor, sem biometria, vem da migração `20260927120000_mafuz_confirmacao_direta.sql`, aplicada junto com as demais pelo kit `supabase/mafuz-proprio/publicar.sh`. No projeto compartilhado atual ela não é aplicada; lá, as visitas do site já chegam como leads e são confirmadas pelo WhatsApp.

Quando o Supabase próprio da MAFUZ estiver no ar (kit em `supabase/mafuz-proprio/`), troque o endereço e a chave nos dois lados: no site com `node supabase/mafuz-proprio/trocar-projeto.mjs` e na Railway em `SITE_SUPABASE_URL` e `SITE_SUPABASE_ANON_KEY`.

## 6 · Conferência final

| Teste | Esperado |
|---|---|
| `https://mafuz-agente-production.up.railway.app/health` | `versao 2.4.0`, WhatsApp `conectado`, `carteira_completa: true` |
| WhatsApp da Gabi › "casa no Alphaville" e "apartamento nas Seis Pistas" | imóveis com link `mafuz.site/imovel/...` que abre a ficha |
| mafuz.site › chat da busca | a Gabi responde com imóveis |
| mafuz.site › filtros da busca | "Imóveis em destaque" vira "Selecionados para você" |
| Ficha de um imóvel › Apresentar | fotos em tela cheia passando sozinhas |
| `/sobre` e `/bairros/vila-da-serra` | páginas novas no ar |
| `/painel` › Painel de controle | abas Imoview · CRM e Site · mafuz.site |
| `/painel` › Conversas | conversas do WhatsApp aparecem |
| `/painel` › 2º Cérebro › "Quantas captações fiz esta semana?" | resposta com número |
| `https://mafuz-agente-production.up.railway.app/admin/resumo?token=SEU_ADMIN_TOKEN` | prévia do resumo das 8h de cada corretor |

Tudo certo: arquive os repositórios antigos (Settings › Archive this repository). Não apague: servem de histórico.

## 7 · Token do Instagram (vídeos no site)

1. A conta @mafuzimoveisdeluxo precisa ser **Profissional** (Comercial ou Criador de conteúdo).
2. [developers.facebook.com](https://developers.facebook.com) › **Criar app** › tipo **Empresa**.
3. No app: **Adicionar produto › Instagram › Configuração da API com login do Instagram**.
4. **Gerar token** para a conta @mafuzimoveisdeluxo e copie.
5. Railway › `INSTAGRAM_TOKEN` = o token. O servidor renova sozinho a cada 20 dias.

Sem o token, o site mostra um convite elegante para o perfil no lugar dos vídeos.

## Segurança

Troque as senhas da gestão no Supabase. Nunca envie o arquivo `.env` para o GitHub (os dois pacotes já vêm sem ele), e as chaves do Imoview, da OpenAI e da Z-API ficam só nas Variables da Railway.
