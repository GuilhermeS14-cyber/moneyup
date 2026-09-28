# FinTCC

Aplicação de finanças pessoais em português brasileiro. O frontend continua responsivo e agora usa um backend Node.js/Express, sessões seguras, PostgreSQL local persistente, isolamento de dados por conta e integração opcional com a OpenAI.

## Rodar no computador

Requisitos: Node.js 20 ou superior e npm. O projeto usa PGlite, PostgreSQL embutido para desenvolvimento; não precisa instalar PostgreSQL separado. O banco fica persistido em `work/pgdata`.

```powershell
npm install
npm run setup
```

Se já existe `.env`, `npm run setup` não o sobrescreve. Inicie os serviços:

```powershell
npm run dev
```

Abra [http://localhost:4173](http://localhost:4173). Para encerrar, pressione Ctrl+C no terminal. O projeto continua no Visual Studio Code.

No cadastro, use uma senha de pelo menos 12 caracteres. Depois do login, o primeiro lançamento pode ser criado manualmente. Para explorar sem inserir dados pessoais, selecione **Carregar dados de exemplo**; são valores fictícios associados somente à conta local atual.

## Configurar a IA

1. Revogue a chave que foi colada na conversa e gere uma nova chave de projeto na plataforma OpenAI.
2. Abra `.env` na pasta do projeto e coloque a nova chave em `OPENAI_API_KEY=`. Não a envie pelo chat, não a cole no código e não a versione.
3. Reinicie `npm run dev`.
4. Na aplicação, ative o consentimento de IA em **Configurações** e salve. Sem consentimento, as rotas de IA não enviam dados financeiros.

A chave é lida pelo servidor através de `process.env.OPENAI_API_KEY`; o browser nunca a recebe. O chat transmite à OpenAI apenas renda agregada do mês, totais por categoria e metas necessárias para responder. A categorização de extratos transmite somente as descrições e tipos das movimentações, e mostra a prévia editável antes de importar. A chamada usa Responses API com `store:false`, limite de tamanho, rate limit e respostas educativas. O assistente não recomenda investimentos individualizados. A chave compartilhada anteriormente deve ser revogada; não foi escrita nos arquivos do projeto.

Variáveis disponíveis em `.env` (segredos não devem ser versionados):

```env
NODE_ENV=development
PORT=4173
SESSION_SECRET=segredo-aleatorio-gerado-pelo-setup
CSRF_SECRET=outro-segredo-aleatorio-gerado-pelo-setup
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
POSTGRES_PASSWORD=segredo-aleatorio-gerado-pelo-setup
DATABASE_SSL=false
```

## Funcionalidades já conectadas

- Cadastro e login; senha armazenada com bcrypt (custo 12), sessão com cookie `HttpOnly`, `SameSite=Strict` e regeneração ao autenticar.
- Proteção CSRF, limite de tentativas de login e mensagens de erro amigáveis.
- CRUD de receitas/despesas, filtros, busca, correção de categoria com memória por usuário e importação CSV/OFX com revisão antes de confirmar.
- Cartões, limite utilizado, fatura e alerta de uso acima de 70%.
- Metas persistidas e contribuições, relatório de movimentações, CSV e impressão/Salvar como PDF.
- Exportação da conta em JSON e exclusão da conta/dados associados.
- Assistente OpenAI, categorização opcional de descrições de extrato, sugestões de metas; tudo requer consentimento explícito.
- Trilhas e notícias de exemplo. O feed não está ligado a um serviço de notícias; nenhuma manchete demonstrativa é apresentada como notícia real.

## PostgreSQL e segurança

`schema.sql` é aplicado automaticamente quando o servidor inicia. O PGlite local fala o protocolo PostgreSQL e grava seus dados no diretório ignorado `work/pgdata`. Para um servidor PostgreSQL normal, configure `DATABASE_URL` e execute o mesmo esquema:

```powershell
$env:DATABASE_URL = 'postgresql://usuario:senha@localhost:5432/fintcc'
psql $env:DATABASE_URL -f schema.sql
npm start
```

As tabelas financeiras usam Row Level Security. Cada operação autenticada abre transação e define `app.user_id` a partir da sessão no servidor; os IDs enviados pelo navegador nunca são aceitos como identidade. Os comandos SQL usam parâmetros. Em produção, use um papel de migração separado do usuário de runtime, TLS para PostgreSQL, HTTPS atrás de proxy reverso, rotação de segredos, monitoramento, limite de tamanho e política de privacidade revisada. A role comum não tem acesso administrativo; a coluna de perfil existe para futura área administrativa.

## Deploy com Docker Compose

O arquivo `compose.yaml` cria PostgreSQL e a aplicação. Configure `.env` com senhas aleatórias e segredos, coloque a nova chave OpenAI se for usar IA e use um proxy HTTPS em frente ao serviço.

```sh
docker compose up --build -d
```

O app fica publicado somente em `127.0.0.1:4173`; o banco não tem porta pública. Em produção, `NODE_ENV=production` habilita cookies Secure. Configure HTTPS e variáveis seguras antes de abrir o serviço a outros dispositivos.

## Backup e LGPD

O banco de desenvolvimento fica em `work/pgdata`; proteja o disco e mantenha cópias independentes. A aplicação tem exportação por conta e exclusão em cascata, mas ainda não há backup diário automático para um local remoto. A revisão automática bloqueou a criação desse envio porque faltam o serviço/destino externo específico e autorização explícita para transmitir o banco financeiro a ele. Para um PostgreSQL implantado, `pg_dump` deve ser agendado diariamente, criptografado antes do envio e guardado em infraestrutura separada; documente retenção e teste a restauração.

Dados de renda per capita são uma divisão informativa da renda declarada pelo tamanho da família, não classificação IBGE/ABEP. A opção exige consentimento e pode ser revogada. Use dados fictícios em desenvolvimento.

## Limitações conhecidas

- PDF bancário não é importado. CSV/OFX é processado no browser; nenhum arquivo bruto é enviado ao servidor.
- As notícias e cursos são conteúdo demonstrativo sem RSS e sem sincronização de progresso entre dispositivos.
- Previsões e relatórios são estimativas locais simples. A IA não substitui aconselhamento profissional.
- Recuperação de senha por e-mail, painel administrativo e backups remotos ainda precisam de uma infraestrutura de produção.

## Diagrama ER

```mermaid
erDiagram
  USUARIOS ||--o{ RECEITAS : registra
  USUARIOS ||--o{ DESPESAS : registra
  USUARIOS ||--o{ CATEGORIAS : define
  USUARIOS ||--o{ CARTOES : possui
  CARTOES ||--o{ FATURAS : gera
  CARTOES ||--o{ DESPESAS : paga
  DESPESAS ||--o{ PARCELAS : divide
  USUARIOS ||--o{ METAS : planeja
  USUARIOS ||--o{ IMPORTACOES_EXTRATO : importa
  USUARIOS ||--o{ RELATORIOS : consulta
  USUARIOS ||--o{ PROGRESSO_CURSOS : aprende
  CURSOS ||--o{ PROGRESSO_CURSOS : acompanha
  USUARIOS ||--o{ CONVERSAS_IA : conversa
  USUARIOS ||--o{ CORRECOES_CATEGORIZACAO : corrige
```
