# BH Verde

Inventário colaborativo da arborização urbana de Belo Horizonte.

## Stack oficial

- Frontend separado em `frontend/`: HTML5, CSS3 e JavaScript puro.
- API separada em `backend/`: Node.js e Express, HTTP/JSON.
- PostgreSQL com extensão PostGIS.
- Prisma ORM 6 para tabelas relacionais e SQL tagged-template parametrizado para operações PostGIS na coluna geométrica `Unsupported("geometry(Point,4326)")`.
- Leaflet com tiles MapTiler e dados cartográficos OpenStreetMap.
- Leaflet.markercluster para agrupamento de marcadores.

Não são usados React, Angular, Vue, C#, ASP.NET Core ou .NET. O frontend nunca conecta diretamente ao banco.

## Iniciar localmente sem banco

O backend usa armazenamento local em JSON por padrão; PostgreSQL, PostGIS, Docker e migrações não são necessários neste modo. É preciso Node.js 20.9 ou superior, npm e uma chave MapTiler pública restrita a `localhost`.

1. Copie `backend/.env.example` para `backend/.env`.
2. Configure `MAPTILER_KEY` e troque `JWT_SECRET` por uma string aleatória com pelo menos 32 caracteres. Deixe `STORAGE_MODE=file`.
3. Na raiz do projeto, rode `npm install` e `npm run dev`.
4. Abra `http://localhost:5173`.

Os usuários e registros serão gravados em `backend/data/bhverde.json`, ignorado pelo Git e criado com permissões restritas ao usuário local. Esse armazenamento é local a esta máquina e serve para desenvolvimento; não oferece cópias de segurança, concorrência entre instâncias ou compartilhamento em produção.

Para ativar PostgreSQL/PostGIS mais tarde, defina `STORAGE_MODE=postgres`, configure `DATABASE_URL`, copie o `.env.example` da raiz para `.env` e defina `POSTGRES_PASSWORD` para coincidir com a senha da URL, inicie `docker compose up -d`, gere o cliente com `npm run db:generate` e aplique a migração com `npm run db:migrate`. O conteúdo JSON local não é importado automaticamente.

O frontend usa `http://localhost:3000/api/v1` por padrão; altere `frontend/js/config.js` para apontar a outra origem da API. Em produção, sirva frontend e backend em origens configuradas e use HTTPS.

## API disponível

- `GET /api/v1/health`: verificação da API e modo de armazenamento ativo.
- `GET /api/v1/config`: fornece a chave pública MapTiler para construir a URL de tiles. Essa chave é visível ao navegador; restrinja-a por domínio e escopo no painel MapTiler. Nunca coloque a senha do banco ou o segredo JWT no frontend.
- `POST /api/v1/auth/register` e `POST /api/v1/auth/login`: contas com senha hash bcrypt e token JWT de curta duração.
- `GET /api/v1/auth/me`: perfil e contagem total de contribuições da conta autenticada.
- `GET /api/v1/contributions?bbox=west,south,east,north`: consulta espacial da área visível, com contagens por categoria. Retorna até 2.000 registros e informa `truncated` se houver mais; aproxime o mapa para buscar áreas menores.
- `POST /api/v1/contributions`: registra categoria, ponto, endereço, descrição e até três fotos JPEG.

As fotos comprimidas permanecem dentro do arquivo JSON neste modo e em JSONB no PostgreSQL; para produção, mova os arquivos para object storage e grave apenas metadados/URLs.

## PostGIS e Prisma

No modo PostgreSQL, Prisma ORM 6 representa `geometry(Point,4326)` como tipo não suportado; o schema usa `Unsupported`, e a migração instala PostGIS e cria índice GiST. Leituras/escritas geográficas usam `$queryRaw` tagged-template parametrizado. A documentação atual também descreve uma extensão PostGIS para Prisma ORM 8: [PostGIS no Prisma](https://www.prisma.io/docs/orm/extensions/postgis); [tipos não suportados no Prisma 6](https://www.prisma.io/docs/orm/v6/prisma-schema/data-model/unsupported-database-features).

## Dados locais existentes

O frontend anterior gravava contas e contribuições no `localStorage`. Essa implementação deixou de ser lida para evitar misturar dados de dispositivos diferentes. Os valores existentes permanecem no navegador e não são apagados nem importados automaticamente. Planeje uma exportação/importação revisável antes de qualquer migração desses dados.

## UI e ícones

O layout e os estilos BH Verde foram preservados em `frontend/index.html` e `frontend/css/`. O sprite 3D local fica em `frontend/assets/icons/categorias-3d.png` e os marcadores usam Leaflet.markercluster, círculos verdes contadores e ícones individuais por categoria.

O arquivo `wwwroot/assets/icons/categorias-3d.png` na raiz foi mantido como cópia legada; a aplicação usa o asset sob `frontend/assets/icons/`.

## Limites atuais

- A sessão JWT fica somente em memória no frontend: recarregar a página encerra a sessão local, e o usuário precisa entrar de novo.
- O login Google continua apenas como opção visual; OAuth não foi configurado.
- A busca de endereço ainda usa Nominatim diretamente no navegador. Antes de produção, revisar políticas e limites do provedor e considerar proxy ou serviço dedicado.
- Marcadores agrupam os até 2.000 registros retornados para a área atual. Quando a API sinaliza truncamento, a interface pede zoom; para áreas de alta densidade, implementar agregação espacial por célula/PostGIS no servidor.
- Nenhuma migração foi executada e nenhum dado antigo do navegador foi excluído ou importado.

## Teste remoto temporário em Linux

O app pode ser compartilhado por uma URL HTTPS usando Caddy como proxy local e um Cloudflare Quick Tunnel. O túnel é temporário e gera uma URL pública nova quando reiniciado.

1. Instale Node.js 20.9+, Caddy e `cloudflared` na máquina Linux.
2. Na raiz do projeto, rode `npm ci` e copie `backend/.env.example` para `backend/.env`. Configure `JWT_SECRET` com uma string aleatória longa e `MAPTILER_KEY` para o domínio de teste. Mantenha `STORAGE_MODE=file` para uma avaliação temporária.
3. Abra três terminais na raiz do projeto:

   ```sh
   npm run dev --workspace frontend
   caddy run --config deploy/Caddyfile.test
   cloudflared tunnel --url http://localhost:8080
   ```

4. Copie a URL `https://....trycloudflare.com` que o `cloudflared` mostrar. No quarto terminal, inicie a API com essa origem permitida:

   ```sh
   FRONTEND_ORIGIN=https://....trycloudflare.com npm run dev --workspace backend
   ```

5. Abra a URL HTTPS no celular ou envie-a para quem vai testar. A API segue pelo mesmo domínio em `/api/v1`; o Caddy encaminha essa rota para a porta 3000 e o restante para a porta 5173.

O `frontend/js/config.js` mantém o endereço `:3000` no desenvolvimento local e usa `/api/v1` na mesma origem quando publicado por proxy. A localização do navegador exige HTTPS fora de `localhost`, então acesse a URL do túnel, não o IP local por HTTP. Registros no modo `file` ficam no arquivo `backend/data/bhverde.json` dessa máquina. Não compartilhe uma URL pública com dados reais ou credenciais de teste reutilizadas.
