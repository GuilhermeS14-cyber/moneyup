require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { doubleCsrf } = require('csrf-csrf');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const OpenAI = require('openai');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
const production = process.env.NODE_ENV === 'production';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6, ssl: production && process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
const ai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 1 }) : null;
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret || sessionSecret.length < 32) {
  console.error('Defina SESSION_SECRET com pelo menos 32 caracteres em .env');
  process.exit(1);
}
if (production && !process.env.DATABASE_URL?.startsWith('postgres')) {
  console.error('Em produção, DATABASE_URL precisa apontar para PostgreSQL com TLS.');
  process.exit(1);
}

app.disable('x-powered-by');
app.set('trust proxy', production ? 1 : false);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
app.use(express.json({ limit: '64kb', type: 'application/json' }));
app.use(session({
  store: new PgSession({ pool, tableName: 'sessoes_web', createTableIfMissing: true }),
  name: production ? '__Host-fintcc.sid' : 'fintcc.sid', secret: sessionSecret,
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'strict', secure: production, maxAge: 8 * 60 * 60 * 1000, path: '/' }
}));
const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => process.env.CSRF_SECRET || sessionSecret,
  getSessionIdentifier: req => req.sessionID,
  cookieName: production ? '__Host-fintcc.csrf' : 'fintcc.csrf',
  cookieOptions: { httpOnly: true, sameSite: 'strict', secure: production, path: '/' },
  size: 64
});
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' } });
const aiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Você atingiu o limite de mensagens por minuto.' } });

function fail(res, status, message) { return res.status(status).json({ error: message }); }
function requireUser(req, res, next) { if (!req.session.userId) return fail(res, 401, 'Entre na sua conta para continuar.'); next(); }
function emailValid(value) { return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function parseAmount(value) { const amount = Number(value); return Number.isFinite(amount) && amount > 0 && amount <= 100000000 ? amount : null; }
function safeUser(row) { return { id: row.id, email: row.email, name: row.nome, income: Number(row.renda_mensal || 0), family: row.pessoas_familia }; }

// Cada operação financeira abre transação e define o dono para as políticas RLS.
async function scoped(req, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [req.session.userId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
async function categoryId(client, userId, name, type) {
  const normalized = String(name || 'Outros').trim().slice(0, 60) || 'Outros';
  const found = await client.query('SELECT id FROM categorias WHERE usuario_id=$1 AND nome=$2 AND tipo=$3', [userId, normalized, type]);
  if (found.rowCount) return found.rows[0].id;
  return (await client.query('INSERT INTO categorias(usuario_id,nome,tipo) VALUES($1,$2,$3) RETURNING id', [userId, normalized, type])).rows[0].id;
}
function dbError(res, error) {
  console.error('Erro interno FinTCC:', error.code || error.name || 'erro');
  if (error.code === '23505') return fail(res, 409, 'Já existe uma conta com este e-mail.');
  if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') return fail(res, 503, 'Banco de dados indisponível. Confira DATABASE_URL e se o PostgreSQL está iniciado.');
  return fail(res, 500, 'Não foi possível concluir esta solicitação. Tente novamente.');
}

app.get('/api/health', (_req, res) => res.json({ app: 'FinTCC', status: 'online', aiConfigured: Boolean(ai) }));
app.get('/api/csrf-token', (req, res) => res.json({ csrfToken: generateToken(req, res) }));

app.post('/api/auth/register', authLimiter, doubleCsrfProtection, async (req, res) => {
  const { name, email, password, income, family, consentData, consentAi } = req.body || {};
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 100 || !emailValid(email)) return fail(res, 400, 'Informe nome e e-mail válidos.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) return fail(res, 400, 'A senha deve ter entre 12 e 128 caracteres.');
  const monthly = income === '' || income == null ? null : parseAmount(income);
  const people = Number(family || 1);
  if (income != null && income !== '' && !monthly) return fail(res, 400, 'Informe uma renda mensal válida.');
  if (!Number.isInteger(people) || people < 1 || people > 30) return fail(res, 400, 'Informe um número válido de pessoas na família.');
  if (consentData !== true) return fail(res, 400, 'É necessário aceitar o aviso de privacidade para criar a conta.');
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query('INSERT INTO usuarios(email,senha_hash,nome,renda_mensal,pessoas_familia,consentimento_ia_em) VALUES(lower($1),$2,$3,$4,$5,$6) RETURNING id,email,nome,renda_mensal,pessoas_familia', [email.trim(), hash, name.trim(), monthly, people, consentAi === true ? new Date() : null]);
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.userId = result.rows[0].id;
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    return res.status(201).json({ user: safeUser(result.rows[0]) });
  } catch (error) { return dbError(res, error); }
});

app.post('/api/auth/login', authLimiter, doubleCsrfProtection, async (req, res) => {
  const { email, password } = req.body || {};
  if (!emailValid(email) || typeof password !== 'string' || password.length > 128) return fail(res, 400, 'Informe e-mail e senha válidos.');
  try {
    const result = await pool.query('SELECT id,email,senha_hash,nome,renda_mensal,pessoas_familia FROM usuarios WHERE email=lower($1)', [email.trim()]);
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(password, row.senha_hash))) return fail(res, 401, 'E-mail ou senha incorretos.');
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.userId = row.id;
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    return res.json({ user: safeUser(row) });
  } catch (error) { return dbError(res, error); }
});

app.post('/api/auth/logout', requireUser, doubleCsrfProtection, (req, res) => req.session.destroy(error => {
  if (error) return fail(res, 500, 'Não foi possível encerrar a sessão.');
  res.clearCookie(production ? '__Host-fintcc.sid' : 'fintcc.sid', { httpOnly: true, sameSite: 'strict', secure: production, path: '/' });
  return res.status(204).end();
}));
app.get('/api/auth/me', requireUser, async (req, res) => {
  try { const result = await pool.query('SELECT id,email,nome,renda_mensal,pessoas_familia FROM usuarios WHERE id=$1', [req.session.userId]); if (!result.rowCount) return fail(res, 401, 'Sessão inválida.'); return res.json({ user: safeUser(result.rows[0]) }); }
  catch (error) { return dbError(res, error); }
});

app.patch('/api/profile', requireUser, doubleCsrfProtection, async (req, res) => {
  const { name, income, family, consentAi, consentIncome } = req.body || {};
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 100) return fail(res, 400, 'Informe um nome válido.');
  const monthly = income === '' || income == null ? null : parseAmount(income);
  const people = Number(family || 1);
  if (income != null && income !== '' && !monthly) return fail(res, 400, 'Informe uma renda mensal válida.');
  if (!Number.isInteger(people) || people < 1 || people > 30) return fail(res, 400, 'Informe um número válido de pessoas na família.');
  try {
    const user = await scoped(req, async c => (await c.query(`UPDATE usuarios SET nome=$2,renda_mensal=$3,pessoas_familia=$4,consentimento_ia_em=CASE WHEN $5 THEN COALESCE(consentimento_ia_em,now()) ELSE NULL END,consentimento_renda_em=CASE WHEN $6 THEN COALESCE(consentimento_renda_em,now()) ELSE NULL END,atualizado_em=now() WHERE id=$1 RETURNING id,email,nome,renda_mensal,pessoas_familia`, [req.session.userId, name.trim(), monthly, people, consentAi === true, consentIncome === true])).rows[0]);
    res.json({ user: safeUser(user), consentAi: Boolean(consentAi), consentIncome: Boolean(consentIncome) });
  } catch (error) { dbError(res, error); }
});
app.get('/api/profile/privacy', requireUser, async (req, res) => {
  try { const row = await scoped(req, async c => (await c.query('SELECT consentimento_ia_em IS NOT NULL AS "consentAi",consentimento_renda_em IS NOT NULL AS "consentIncome" FROM usuarios WHERE id=$1', [req.session.userId])).rows[0]); res.json(row || { consentAi:false, consentIncome:false }); }
  catch (error) { dbError(res, error); }
});

app.use('/api', doubleCsrfProtection, requireUser);

app.post('/api/demo-data', async (req,res)=>{
  const date=(dayOffset)=>{const d=new Date();d.setDate(Math.max(1,d.getDate()-dayOffset));return d.toISOString().slice(0,10)};
  const demo=[['Salário — Empresa Exemplo','receita','Salário',4200,0],['Freelance: arte para cliente fictício','receita','Freelance',850,2],['Mercado do bairro','despesa','Alimentação',384.70,1],['Aluguel','despesa','Moradia',1200,3],['Curso online demonstrativo','despesa','Educação',149.90,4],['Transporte por aplicativo','despesa','Transporte',68.50,1],['Farmácia','despesa','Saúde',74.30,5],['Assinatura de streaming (exemplo)','despesa','Lazer',29.90,6]];
  try{
    const created=await scoped(req,async c=>{
      const existing=await c.query('SELECT EXISTS(SELECT 1 FROM receitas WHERE usuario_id=$1) OR EXISTS(SELECT 1 FROM despesas WHERE usuario_id=$1) AS has_data',[req.session.userId]);
      if(existing.rows[0].has_data)return false;
      for(const [description,type,category,value,offset] of demo){const cat=await categoryId(c,req.session.userId,category,type);if(type==='receita')await c.query('INSERT INTO receitas(usuario_id,categoria_id,descricao,valor,data) VALUES($1,$2,$3,$4,$5)',[req.session.userId,cat,description,value,date(offset)]);else await c.query('INSERT INTO despesas(usuario_id,categoria_id,descricao,valor,data,forma_pagamento) VALUES($1,$2,$3,$4,$5,\'pix\')',[req.session.userId,cat,description,value,date(offset)]);}
      await c.query('INSERT INTO metas(usuario_id,nome,valor_alvo,valor_guardado,prazo,aporte_mensal) VALUES($1,\'Reserva de emergência\',8000,2100,CURRENT_DATE+interval \'6 months\',400),($1,\'Viagem de exemplo\',3500,1200,CURRENT_DATE+interval \'8 months\',300)',[req.session.userId]);
      const card=(await c.query('INSERT INTO cartoes(usuario_id,nome,bandeira,limite,dia_fechamento,dia_vencimento) VALUES($1,\'Cartão de demonstração\',\'Visa\',3000,10,17) RETURNING id',[req.session.userId])).rows[0];
      await c.query('INSERT INTO faturas(usuario_id,cartao_id,mes,vencimento,valor) VALUES($1,$2,date_trunc(\'month\',CURRENT_DATE)::date,CURRENT_DATE+interval \'17 days\',340.20)',[req.session.userId,card.id]);
      return true;
    });
    if(!created)return fail(res,409,'Sua conta já tem movimentações; os exemplos não foram adicionados.');
    res.status(201).json({created:true});
  }catch(error){dbError(res,error);}
});

app.get('/api/transactions', async (req, res) => {
  try {
    const rows = await scoped(req, async client => (await client.query(`SELECT id,descricao AS d,'receita' AS type,COALESCE(c.nome,'Outros') AS cat,data::text AS date,'Transferência' AS pay,valor::float AS value FROM receitas r LEFT JOIN categorias c ON c.id=r.categoria_id WHERE r.usuario_id=$1 UNION ALL SELECT d.id,d.descricao,'despesa',COALESCE(c.nome,'Outros'),d.data::text,d.forma_pagamento,d.valor::float FROM despesas d LEFT JOIN categorias c ON c.id=d.categoria_id WHERE d.usuario_id=$1 ORDER BY date DESC`, [req.session.userId])).rows);
    res.json({ transactions: rows });
  } catch (error) { dbError(res, error); }
});
app.post('/api/transactions', async (req, res) => {
  const { description, type, category, date, payment, value } = req.body || {};
  const amount = parseAmount(value);
  if (typeof description !== 'string' || !description.trim() || description.length > 180 || !['receita','despesa'].includes(type) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !amount) return fail(res, 400, 'Confira descrição, tipo, data e valor do lançamento.');
  try {
    const item = await scoped(req, async client => {
      const catId = await categoryId(client, req.session.userId, category, type);
      if (type === 'receita') return (await client.query('INSERT INTO receitas(usuario_id,categoria_id,descricao,valor,data) VALUES($1,$2,$3,$4,$5) RETURNING id,descricao AS d,valor::float AS value,data::text AS date', [req.session.userId, catId, description.trim(), amount, date])).rows[0];
      const validPayment = ['dinheiro','debito','credito','pix','transferencia','outro'].includes(payment) ? payment : 'outro';
      return (await client.query('INSERT INTO despesas(usuario_id,categoria_id,descricao,valor,data,forma_pagamento) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,descricao AS d,valor::float AS value,data::text AS date,forma_pagamento AS pay', [req.session.userId, catId, description.trim(), amount, date, validPayment])).rows[0];
    });
    res.status(201).json({ transaction: { ...item, type, cat: category || 'Outros', pay: item.pay || 'Transferência' } });
  } catch (error) { dbError(res, error); }
});
app.delete('/api/transactions/:id', async (req, res) => {
  try { const count = await scoped(req, async client => { const a = await client.query('DELETE FROM receitas WHERE id=$1 AND usuario_id=$2', [req.params.id, req.session.userId]); const b = await client.query('DELETE FROM despesas WHERE id=$1 AND usuario_id=$2', [req.params.id, req.session.userId]); return a.rowCount + b.rowCount; }); if (!count) return fail(res, 404, 'Lançamento não encontrado.'); res.status(204).end(); }
  catch (error) { dbError(res, error); }
});
app.post('/api/import', async (req, res) => {
  const rows = req.body?.transactions;
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) return fail(res, 400, 'O extrato deve conter de 1 a 500 lançamentos.');
  for (const t of rows) if (typeof t.description !== 'string' || !t.description.trim() || t.description.length > 180 || !['receita','despesa'].includes(t.type) || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !parseAmount(t.value)) return fail(res, 400, 'Revise os dados do extrato e tente novamente.');
  try {
    await scoped(req, async c => {
      for (const t of rows) {
        const cat = await categoryId(c, req.session.userId, t.category, t.type);
        if (t.type === 'receita') await c.query('INSERT INTO receitas(usuario_id,categoria_id,descricao,valor,data,origem) VALUES($1,$2,$3,$4,$5,\'extrato\')', [req.session.userId,cat,t.description.trim(),parseAmount(t.value),t.date]);
        else await c.query('INSERT INTO despesas(usuario_id,categoria_id,descricao,valor,data,forma_pagamento,origem) VALUES($1,$2,$3,$4,$5,$6,\'extrato\')', [req.session.userId,cat,t.description.trim(),parseAmount(t.value),t.date,['dinheiro','debito','credito','pix','transferencia','outro'].includes(t.payment)?t.payment:'outro']);
      }
    });
    res.status(201).json({ imported: rows.length });
  } catch (error) { dbError(res, error); }
});
app.patch('/api/transactions/:id', async (req, res) => {
  const { category } = req.body || {};
  if (typeof category !== 'string' || category.trim().length < 1 || category.length > 60) return fail(res, 400, 'Informe uma categoria válida.');
  try {
    const result = await scoped(req, async c => {
      const a = await c.query('UPDATE receitas SET categoria_id=$1 WHERE id=$2 AND usuario_id=$3 RETURNING descricao AS d,\'receita\' AS type,data::text AS date,valor::float AS value', [await categoryId(c,req.session.userId,category,'receita'),req.params.id,req.session.userId]);
      if (a.rowCount) return {...a.rows[0],cat:category};
      const b=await c.query('UPDATE despesas SET categoria_id=$1 WHERE id=$2 AND usuario_id=$3 RETURNING descricao AS d,\'despesa\' AS type,data::text AS date,forma_pagamento AS pay,valor::float AS value', [await categoryId(c,req.session.userId,category,'despesa'),req.params.id,req.session.userId]);
      return b.rowCount?{...b.rows[0],cat:category}:null;
    });
    if(!result) return fail(res,404,'Lançamento não encontrado.');
    const normalized=String(result.d).toLowerCase().replace(/[^\p{L}\p{N} ]/gu,' ').replace(/\s+/g,' ').trim();
    const catId=await scoped(req, async c=>categoryId(c,req.session.userId,category,result.type));
    await scoped(req,async c=>c.query(`INSERT INTO correcoes_categorizacao(usuario_id,descricao_normalizada,tipo,categoria_id) VALUES($1,$2,$3,$4) ON CONFLICT(usuario_id,descricao_normalizada,tipo) DO UPDATE SET categoria_id=EXCLUDED.categoria_id,ocorrencias=correcoes_categorizacao.ocorrencias+1,atualizado_em=now()`,[req.session.userId,normalized,result.type,catId]));
    res.json({ transaction:result });
  } catch(error){dbError(res,error);}
});

app.get('/api/goals', async (req, res) => {
  try { const goals = await scoped(req, async c => (await c.query('SELECT id,nome AS name,valor_alvo::float AS target,valor_guardado::float AS saved,prazo::text AS deadline,aporte_mensal::float AS monthly FROM metas WHERE usuario_id=$1 ORDER BY criada_em', [req.session.userId])).rows); res.json({ goals }); }
  catch (error) { dbError(res, error); }
});
app.post('/api/goals', async (req, res) => {
  const { name, target, saved, deadline, monthly } = req.body || {};
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 100 || !parseAmount(target)) return fail(res, 400, 'Informe um nome e valor válidos para a meta.');
  try { const goal = await scoped(req, async c => (await c.query('INSERT INTO metas(usuario_id,nome,valor_alvo,valor_guardado,prazo,aporte_mensal) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,nome AS name,valor_alvo::float AS target,valor_guardado::float AS saved,prazo::text AS deadline,aporte_mensal::float AS monthly', [req.session.userId, name.trim(), parseAmount(target), Math.max(0, Number(saved) || 0), deadline || null, Math.max(0, Number(monthly) || 0)])).rows[0]); res.status(201).json({ goal }); }
  catch (error) { dbError(res, error); }
});
app.patch('/api/goals/:id/contributions', async (req, res) => {
  const amount=parseAmount(req.body?.amount);
  if(!amount)return fail(res,400,'Informe um valor de aporte maior que zero.');
  try{const goal=await scoped(req,async c=>(await c.query('UPDATE metas SET valor_guardado=valor_guardado+$1 WHERE id=$2 AND usuario_id=$3 RETURNING id,nome AS name,valor_alvo::float AS target,valor_guardado::float AS saved,prazo::text AS deadline,aporte_mensal::float AS monthly',[amount,req.params.id,req.session.userId])).rows[0]);if(!goal)return fail(res,404,'Meta não encontrada.');res.json({goal});}
  catch(error){dbError(res,error);}
});
app.delete('/api/goals/:id', async (req,res)=>{
  try{const result=await scoped(req,async c=>c.query('DELETE FROM metas WHERE id=$1 AND usuario_id=$2',[req.params.id,req.session.userId]));if(!result.rowCount)return fail(res,404,'Meta não encontrada.');res.status(204).end();}
  catch(error){dbError(res,error);}
});

app.get('/api/cards', async (req, res) => {
  try { const cards = await scoped(req, async c => (await c.query(`SELECT c.id,c.nome AS name,c.bandeira AS brand,c.limite::float AS "limit",c.dia_fechamento AS close,c.dia_vencimento AS due,COALESCE(sum(f.valor),0)::float AS used FROM cartoes c LEFT JOIN faturas f ON f.cartao_id=c.id AND f.usuario_id=c.usuario_id AND f.paga_em IS NULL WHERE c.usuario_id=$1 GROUP BY c.id ORDER BY c.criado_em`, [req.session.userId])).rows); res.json({ cards }); }
  catch (error) { dbError(res, error); }
});
app.post('/api/cards', async (req, res) => {
  const { name, brand, limit, close, due, used } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || !parseAmount(limit) || !Number.isInteger(Number(close)) || close < 1 || close > 31 || !Number.isInteger(Number(due)) || due < 1 || due > 31) return fail(res, 400, 'Confira os dados do cartão.');
  try { const card = await scoped(req, async c => { const value = parseAmount(used) || 0; const inserted = (await c.query('INSERT INTO cartoes(usuario_id,nome,bandeira,limite,dia_fechamento,dia_vencimento) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,nome AS name,bandeira AS brand,limite::float AS "limit",dia_fechamento AS close,dia_vencimento AS due', [req.session.userId, name.trim(), String(brand || 'Outro').slice(0,30), parseAmount(limit), close, due])).rows[0]; if(value) await c.query('INSERT INTO faturas(usuario_id,cartao_id,mes,vencimento,valor) VALUES($1,$2,date_trunc(\'month\',CURRENT_DATE)::date,make_date(extract(year from CURRENT_DATE)::int,extract(month from CURRENT_DATE)::int,LEAST($3,extract(day from (date_trunc(\'month\',CURRENT_DATE)+interval \'1 month - 1 day\'))::int)), $4)', [req.session.userId, inserted.id, due, value]); return {...inserted,used:value}; }); res.status(201).json({ card }); }
  catch (error) { dbError(res, error); }
});
app.delete('/api/cards/:id', async(req,res)=>{
  try{const result=await scoped(req,async c=>c.query('DELETE FROM cartoes WHERE id=$1 AND usuario_id=$2',[req.params.id,req.session.userId]));if(!result.rowCount)return fail(res,404,'Cartão não encontrado.');res.status(204).end();}
  catch(error){dbError(res,error);}
});

app.get('/api/export', async (req, res) => {
  try {
    const dump = await scoped(req, async c => {
      const user = (await c.query('SELECT email,nome,renda_mensal,pessoas_familia,criado_em FROM usuarios WHERE id=$1', [req.session.userId])).rows[0];
      const transactions = (await c.query(`SELECT descricao,valor,data,tipo,nome AS categoria FROM (SELECT r.descricao,r.valor,r.data,'receita' AS tipo,c.nome FROM receitas r LEFT JOIN categorias c ON c.id=r.categoria_id WHERE r.usuario_id=$1 UNION ALL SELECT d.descricao,d.valor,d.data,'despesa',c.nome FROM despesas d LEFT JOIN categorias c ON c.id=d.categoria_id WHERE d.usuario_id=$1) x ORDER BY data`, [req.session.userId])).rows;
      const goals = (await c.query('SELECT nome,valor_alvo,valor_guardado,prazo FROM metas WHERE usuario_id=$1', [req.session.userId])).rows;
      const cards = (await c.query('SELECT nome,bandeira,limite,dia_fechamento,dia_vencimento FROM cartoes WHERE usuario_id=$1', [req.session.userId])).rows;
      return { user, transactions, goals, cards, exportadoEm: new Date().toISOString() };
    });
    res.setHeader('Content-Disposition', 'attachment; filename="fintcc-dados.json"'); res.type('application/json').send(JSON.stringify(dump, null, 2));
  } catch (error) { dbError(res, error); }
});
app.delete('/api/account', async (req, res) => {
  try {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query("SELECT set_config('app.user_id',$1,true)", [req.session.userId]); await client.query('DELETE FROM usuarios WHERE id=$1', [req.session.userId]); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await new Promise(resolve => req.session.destroy(() => resolve()));
    res.clearCookie(production ? '__Host-fintcc.sid' : 'fintcc.sid', { httpOnly: true, sameSite: 'strict', secure: production, path: '/' });
    res.status(204).end();
  } catch (error) { dbError(res, error); }
});

app.post('/api/ai/chat', aiLimiter, async (req, res) => {
  if (!ai) return fail(res, 503, 'Assistente indisponível: configure a chave OpenAI no servidor.');
  const question = typeof req.body?.question === 'string' ? req.body.question.trim().slice(0, 1500) : '';
  if (!question) return fail(res, 400, 'Escreva uma pergunta para o assistente.');
  try {
    const summary = await scoped(req, async c => {
      const consent = (await c.query('SELECT consentimento_ia_em FROM usuarios WHERE id=$1', [req.session.userId])).rows[0]?.consentimento_ia_em;
      if (!consent) { const e = new Error('CONSENT_REQUIRED'); e.code = 'CONSENT_REQUIRED'; throw e; }
      const income = (await c.query('SELECT COALESCE(sum(valor),0)::float AS total FROM receitas WHERE usuario_id=$1 AND date_trunc(\'month\',data)=date_trunc(\'month\',CURRENT_DATE)', [req.session.userId])).rows[0].total;
      const expenses = (await c.query(`SELECT COALESCE(c.nome,'Outros') AS category, sum(d.valor)::float AS total FROM despesas d LEFT JOIN categorias c ON c.id=d.categoria_id WHERE d.usuario_id=$1 AND date_trunc('month',d.data)=date_trunc('month',CURRENT_DATE) GROUP BY c.nome ORDER BY total DESC`, [req.session.userId])).rows;
      const goals = (await c.query('SELECT nome,valor_alvo::float AS target,valor_guardado::float AS saved,aporte_mensal::float AS monthly FROM metas WHERE usuario_id=$1 LIMIT 10', [req.session.userId])).rows;
      return { monthlyIncome: income, expensesByCategory: expenses, goals };
    });
    // Dados mínimos e agregados: não enviamos nome, e-mail, descrições de compras ou IDs.
    const response = await ai.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', store: false, max_output_tokens: 500,
      instructions: 'Você é um educador financeiro brasileiro. Responda em pt-BR, em linguagem acessível, usando apenas os dados agregados fornecidos. Não recomende investimentos individualizados, não invente dados ausentes. Seja transparente sobre estimativas e incentive decisões informadas. Os dados financeiros enviados são confidenciais; não peça identificadores pessoais.',
      input: `Dados financeiros agregados do usuário (mês atual): ${JSON.stringify(summary)}\nPergunta: ${question}`
    });
    res.json({ answer: response.output_text || 'Não consegui gerar uma resposta agora. Tente novamente.' });
  } catch (error) {
    console.error('Falha na integração IA:', error.status || error.name || 'erro');
    if (error.code === 'CONSENT_REQUIRED') return fail(res, 403, 'Ative o consentimento para uso da IA nas configurações antes de conversar.');
    if (error.status === 429) return fail(res, 503, 'O assistente está ocupado no momento. Tente novamente em instantes.');
    return fail(res, 502, 'Não foi possível consultar o assistente agora. Seus lançamentos continuam salvos.');
  }
});
app.post('/api/ai/categorize', aiLimiter, async (req,res)=>{
  if(!ai)return fail(res,503,'Categorização com IA indisponível; use as sugestões locais.');
  const items=req.body?.items;
  if(!Array.isArray(items)||items.length<1||items.length>100||items.some(x=>typeof x.description!=='string'||x.description.length>180||!['receita','despesa'].includes(x.type)))return fail(res,400,'Confira a lista de descrições do extrato.');
  try{
    const categorized=await scoped(req,async c=>{
      const consent=(await c.query('SELECT consentimento_ia_em FROM usuarios WHERE id=$1',[req.session.userId])).rows[0]?.consentimento_ia_em;
      if(!consent){const e=new Error('CONSENT_REQUIRED');e.code='CONSENT_REQUIRED';throw e;}
      const output=[];const pending=[];
      for(let i=0;i<items.length;i++){
        const normalized=items[i].description.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
        const hit=await c.query('SELECT c.nome FROM correcoes_categorizacao x JOIN categorias c ON c.id=x.categoria_id WHERE x.usuario_id=$1 AND x.descricao_normalizada=$2 AND x.tipo=$3',[req.session.userId,normalized,items[i].type]);
        if(hit.rowCount)output[i]={category:hit.rows[0].nome,source:'correction'};else pending.push({index:i,description:items[i].description,type:items[i].type});
      }
      if(pending.length){
        const response=await ai.responses.create({model:process.env.OPENAI_MODEL||'gpt-4.1-mini',store:false,max_output_tokens:600,instructions:'Classifique descrições de movimentações financeiras brasileiras nas categorias mais adequadas. Responda APENAS JSON válido como uma lista de objetos {"index": número, "category": string}. Categorias permitidas: Alimentação, Moradia, Transporte, Educação, Lazer, Saúde, Salário, Freelance, Outros. Não inclua valores, datas, pessoas nem explicações.',input:JSON.stringify(pending.map(x=>({index:x.index,description:x.description,type:x.type})))});
        let parsed=JSON.parse(response.output_text||'[]');for(const row of parsed)if(Number.isInteger(row.index)&&pending.some(x=>x.index===row.index)&&typeof row.category==='string')output[row.index]={category:['Alimentação','Moradia','Transporte','Educação','Lazer','Saúde','Salário','Freelance','Outros'].includes(row.category)?row.category:'Outros',source:'ai'};
      }
      return items.map((_,i)=>output[i]||{category:'Outros',source:'fallback'});
    });
    res.json({categories:categorized});
  }catch(error){
    if(error.code==='CONSENT_REQUIRED')return fail(res,403,'Ative o consentimento para uso da IA nas configurações antes de categorizar.');
    console.error('Falha na categorização IA:',error.status||error.name||'erro');
    return fail(res,502,'Não foi possível categorizar com IA agora. Você pode usar as categorias sugeridas localmente.');
  }
});
app.post('/api/ai/plan-goal', aiLimiter, async(req,res)=>{
  if(!ai)return fail(res,503,'Planejamento com IA indisponível; tente novamente mais tarde.');
  const {name,target,saved,monthly,deadline}=req.body||{};
  if(typeof name!=='string'||name.length>100||!parseAmount(target)||!Number.isFinite(Number(saved))||Number(saved)<0)return fail(res,400,'Informe uma meta válida.');
  try{
    const consent=await scoped(req,async c=>(await c.query('SELECT consentimento_ia_em FROM usuarios WHERE id=$1',[req.session.userId])).rows[0]?.consentimento_ia_em);
    if(!consent)return fail(res,403,'Ative o consentimento de IA nas configurações para solicitar um plano.');
    const response=await ai.responses.create({model:process.env.OPENAI_MODEL||'gpt-4.1-mini',store:false,max_output_tokens:350,instructions:'Você é um educador financeiro brasileiro. Crie um plano simples, realista e encorajador para uma meta, em pt-BR. Não recomende investimentos individuais. Mostre quanto falta e uma sugestão mensal considerando prazo e capacidade indicada. Se não couber, sugira ampliar prazo ou reduzir a meta. Não invente dados nem pressione o usuário.',input:JSON.stringify({objetivo:name,valorAlvo:Number(target),valorGuardado:Number(saved),aporteMensalDisponivel:Number(monthly)||0,prazo:deadline||null})});
    res.json({plan:response.output_text||'Não consegui criar um plano agora. Tente novamente.'});
  }catch(error){console.error('Falha ao planejar meta com IA:',error.status||error.name||'erro');res.status(502).json({error:'Não foi possível consultar a IA agora. Tente novamente em instantes.'});}
});

app.use('/api', (_req, res) => fail(res, 404, 'Rota não encontrada.'));
app.get(['/', '/index.html'], (_req, res) => { res.setHeader('Cache-Control','no-store'); res.sendFile(path.join(__dirname,'index.html')); });
app.use((_req,res)=>fail(res,404,'Página não encontrada.'));
app.use((err, _req, res, _next) => { if (err.code === 'EBADCSRFTOKEN') return fail(res, 403, 'A sessão de segurança expirou. Atualize a página e tente novamente.'); console.error('Erro de requisição:', err.status || err.name); return fail(res, 400, 'A solicitação não pôde ser processada.'); });

const port = Number(process.env.PORT || 4173);
async function start() {
  try {
    await pool.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
    const host = production ? '0.0.0.0' : '127.0.0.1';
    app.listen(port, host, () => console.log(`FinTCC disponível em http://localhost:${port}`));
  } catch (error) {
    console.error('Não foi possível preparar o PostgreSQL. Confira DATABASE_URL e se o banco está ativo.');
    console.error(error.message);
    process.exit(1);
  }
}
start();
