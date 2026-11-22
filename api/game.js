const { Pool } = require('pg');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
let pool;
// One-time, authenticated player-specific deadline exception for tonight only.
const BELLA_EXTENSION_END = '2026-11-22T21:10:00.000Z';
const BELLA_EXTENSION_ROUNDS = new Set(['daily-2026-11-22','winner-2026-11-22','next-camp-leader-after-wayne-2026']);
const bellaRound = (player,roundKey) => player?.display_name?.toLowerCase() === 'bella' && BELLA_EXTENSION_ROUNDS.has(roundKey);
const hash = v => createHash('sha256').update(v).digest('hex');
const equal = (a,b) => typeof a==='string' && typeof b==='string' && timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
const fail = (status,message) => { const e=new Error(message);e.status=status;throw e; };
const clean = (v,max=300) => typeof v==='string' && v.trim().length>0 && v.trim().length<=max ? v.trim() : fail(400,'Invalid text field');
const uuid = v => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : fail(400,'Invalid ID');
const date = v => typeof v==='string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : fail(400,'A timestamp with timezone is required');
const token = req => (req.headers.authorization||'').match(/^Bearer ([^ ]+)$/i)?.[1]||'';
async function getPlayer(c,req,required=true) {
 const t=token(req);const r=t?await c.query('select id,display_name from jungle.players where token_hash=$1',[hash(t)]):{rows:[]};
 if(required&&!r.rows.length)fail(401,'Join the game first');return r.rows[0]||null;
}
function admin(req){return !!process.env.GAME_MASTER_SECRET && equal(token(req),process.env.GAME_MASTER_SECRET)}
const requireAdmin = req => {if(!admin(req))fail(403,'Game master access required')};
async function state(c,req) {
 const me=await getPlayer(c,req,false), isAdmin=admin(req);
 if(!me&&!isAdmin)return {mode:'live',player:null,rounds:[],leaderboard:[],trophies:[]};
 const {rows:rounds}=await c.query('select id,round_key,title,category,opens_at,closes_at,clock_timestamp()>=closes_at as locked from jungle.rounds where opens_at<=clock_timestamp() or $1 order by closes_at desc limit 100',[isAdmin]);
 for(const round of rounds){if(bellaRound(me,round.round_key)){round.closes_at=BELLA_EXTENSION_END;round.locked=Date.now()>=Date.parse(BELLA_EXTENSION_END)}}
 const {rows:questions}=await c.query(`select q.id,q.round_id,q.position,q.prompt,q.options,q.points,q.max_choices,q.resolution_rule,q.status,
 case when r.closes_at<=clock_timestamp() then q.answer end as answer,
 case when r.closes_at<=clock_timestamp() then q.evidence end as evidence,
 p.choice as my_choice from jungle.questions q join jungle.rounds r on r.id=q.round_id
 left join jungle.predictions p on p.question_id=q.id and p.player_id=$2
 where q.round_id=any($1::uuid[]) order by q.position`,[rounds.map(r=>r.id),me?.id||null]);
 const {rows:leaderboard}=await c.query(`select pl.display_name as name,coalesce(sum(jungle.score_choice(q.status,q.answer,p.choice,q.points,q.max_choices)),0)::int as points,
 count(*) filter(where q.status='settled' and jungle.perfect_choice(q.answer,p.choice,q.max_choices))::int as correct
 from jungle.players pl left join jungle.predictions p on p.player_id=pl.id left join jungle.questions q on q.id=p.question_id
 group by pl.id,pl.display_name order by points desc,correct desc,pl.display_name asc limit 100`);
 const {rows:trophies}=await c.query(`with completed as (
 select r.id,r.title,r.category,count(q.id) filter(where q.status='settled')::int as valid_questions
 from jungle.rounds r join jungle.questions q on q.round_id=r.id
 where r.closes_at<=clock_timestamp() and r.category<>'champion' group by r.id
 having count(*) filter(where q.status='pending')=0 and count(*) filter(where q.status='settled')>0
 ), scores as (
 select r.id,r.title,r.category,r.valid_questions,pl.display_name as player,
 sum(jungle.score_choice(q.status,q.answer,p.choice,q.points,q.max_choices))::int as points,
 count(*) filter(where q.status='settled' and jungle.perfect_choice(q.answer,p.choice,q.max_choices))::int as correct
 from completed r join jungle.questions q on q.round_id=r.id join jungle.predictions p on p.question_id=q.id
 join jungle.players pl on pl.id=p.player_id group by r.id,r.title,r.category,r.valid_questions,pl.id,pl.display_name
 ), ranked as (select *,dense_rank() over(partition by id order by points desc) as rank from scores)
 select title,player,points,case when category='daily' then 'Daily champion' else 'Competition champion' end as trophy
 from ranked where rank=1 and points>0
 union all select title,player,points,'Perfect round' as trophy from ranked where correct=valid_questions
 order by title,player,trophy limit 200`);
 const {rows:winnerPot}=me?await c.query(`select p.choice as celebrity,count(*)::int as picks,sum(q.points)::int as potential_points from jungle.predictions p join jungle.questions q on q.id=p.question_id join jungle.rounds r on r.id=q.round_id where p.player_id=$1 and r.category='champion' and q.status<>'void' group by p.choice order by picks desc,p.choice`,[me.id]):{rows:[]};
 return {mode:'live',player:me,rounds:rounds.map(r=>({...r,questions:questions.filter(q=>q.round_id===r.id&&q.status!=='void')})),leaderboard,trophies,winnerPot,...(me&&process.env.JOIN_CODE?{inviteCode:process.env.JOIN_CODE}:{})};
}
async function join(c,b) {
 if(!process.env.JOIN_CODE||!equal(b.invite,process.env.JOIN_CODE))fail(403,'Invalid invite code');
 const name=clean(b.name,40);if(name.length<2)fail(400,'Use at least two characters');
 const t=randomBytes(32).toString('base64url'), id=randomUUID();
 const r=await c.query('insert into jungle.players(id,display_name,token_hash) values($1,$2,$3) on conflict do nothing returning id,display_name',[id,name,hash(t)]);
 if(!r.rows.length)fail(409,'That display name is already taken');return {token:t,player:r.rows[0]};
}
// Recovery links are bound to the current player token hash, expire and are consumed by rotation.
const recoverySignature=(payload,tokenHash)=>hash('jungle-recovery-v1:'+payload+':'+tokenHash);
async function issueRecovery(c,b,req){
 const isAdmin=admin(req);
 const me=isAdmin?null:await getPlayer(c,req);
 const player=(await c.query(isAdmin?'select id,display_name,token_hash from jungle.players where lower(display_name)=lower($1)':'select id,display_name,token_hash from jungle.players where id=$1',[isAdmin?clean(b.name,40):me.id])).rows[0];
 if(!player)fail(404,'Player not found');
 const expiry=Math.floor(Date.now()/1000)+172800;
 const payload=player.id+'.'+expiry+'.'+randomBytes(16).toString('hex');
 return {code:payload+'.'+recoverySignature(payload,player.token_hash),expiresAt:new Date(expiry*1000).toISOString()};
}
async function recover(c,b){
 const code=typeof b.code==='string'?b.code:'';
 const match=code.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9]{10})\.([0-9a-f]{32})\.([0-9a-f]{64})$/);
 const invalid=()=>fail(403,'This recovery link is invalid, expired, or already used. Ask your game host for another one.');
 if(!match||Number(match[2])<=Math.floor(Date.now()/1000))invalid();
 const [,id,expiry,nonce,signature]=match;
 const player=(await c.query('select id,display_name,token_hash from jungle.players where id=$1 for update',[id])).rows[0];
 if(!player||!equal(signature,recoverySignature(id+'.'+expiry+'.'+nonce,player.token_hash)))invalid();
 const t=randomBytes(32).toString('base64url');
 await c.query('update jungle.players set token_hash=$2 where id=$1',[id,hash(t)]);
 return {token:t,player:{id:player.id,display_name:player.display_name}};
}
function normalChoice(value,q,resolving=false){if(q.max_choices===1){if(typeof value!=='string'||!q.options.includes(value))fail(400,'Invalid answer');return value;}if(!Array.isArray(value)||value.length<1||(!resolving&&value.length>q.max_choices)||value.length>q.options.length||new Set(value).size!==value.length||value.some(v=>typeof v!=='string'||!q.options.includes(v)))fail(400,'Select up to '+q.max_choices+' different campmates');if(value.includes('Nobody is selected')&&value.length!==1)fail(400,'Nobody must be selected on its own');return JSON.stringify([...value].sort());}
async function submit(c,b,req) {
 const player=await getPlayer(c,req);const id=uuid(b.roundId);
 if(!Array.isArray(b.answers)||!b.answers.length||b.answers.length>30)fail(400,'Invalid predictions');
 const r=(await c.query('select *, opens_at<=clock_timestamp() and closes_at>clock_timestamp() as open from jungle.rounds where id=$1 for share',[id])).rows[0];
 if(!r||(!r.open&&!(bellaRound(player,r.round_key)&&Date.now()<Date.parse(BELLA_EXTENSION_END))))fail(409,'This round is not open');
 const qs=(await c.query("select id,options,max_choices from jungle.questions where round_id=$1 and status='pending'",[id])).rows;
 const seen=new Set();
 for(const a of b.answers){
  const question=qs.find(q=>q.id===a.questionId);if(!question||seen.has(a.questionId))fail(400,'Invalid answer');const choice=normalChoice(a.choice,question);
  seen.add(a.questionId);
  const s=await c.query(`insert into jungle.predictions(player_id,question_id,choice) select $1,$2,$3 where exists(select 1 from jungle.rounds where id=$4 and opens_at<=clock_timestamp() and (closes_at>clock_timestamp() or ($5::boolean and clock_timestamp() < $6::timestamptz)))
  on conflict(player_id,question_id) do update set choice=excluded.choice,updated_at=clock_timestamp() returning question_id`,[player.id,question.id,choice,id,bellaRound(player,r.round_key),BELLA_EXTENSION_END]);
  if(!s.rowCount)fail(409,'The deadline has passed');
 }
 return {saved:seen.size};
}
async function publish(c,b) {
 const roundKey=clean(b.roundKey,100),title=clean(b.title,100);
 if(!['daily','trial','survivor','eviction','champion','final'].includes(b.category))fail(400,'Invalid category');
 const opens=date(b.opensAt),closes=date(b.closesAt);
 if(Date.parse(closes)<=Date.parse(opens)||Date.parse(closes)<=Date.now())fail(400,'Deadline must be in the future');
 if(!Array.isArray(b.questions)||b.questions.length<1||b.questions.length>15)fail(400,'Invalid question count');
 const questions=b.questions.map(q=>{
  if(!Array.isArray(q.options)||q.options.length<2||q.options.length>35)fail(400,'Invalid options');
  const options=q.options.map(o=>clean(o,100));if(new Set(options.map(o=>o.toLowerCase())).size!==options.length)fail(400,'Duplicate options');
  if(!Number.isInteger(q.points)||q.points<1||q.points>20)fail(400,'Invalid points');
  const maxChoices=q.maxChoices??1;if(!Number.isInteger(maxChoices)||maxChoices<1||maxChoices>3)fail(400,'Invalid maximum choices');return {prompt:clean(q.prompt,300),resolutionRule:clean(q.resolutionRule,1000),options,points:q.points,maxChoices};
 });
 const id=randomUUID();
 const r=await c.query('insert into jungle.rounds(id,round_key,title,category,opens_at,closes_at) values($1,$2,$3,$4,$5,$6) on conflict(round_key) do nothing returning id',[id,roundKey,title,b.category,opens,closes]);
 if(!r.rowCount)return {created:false,id:(await c.query('select id from jungle.rounds where round_key=$1',[roundKey])).rows[0].id};
 for(const [i,q] of questions.entries())await c.query('insert into jungle.questions(id,round_id,position,prompt,options,points,resolution_rule,max_choices) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8)',[randomUUID(),id,i+1,q.prompt,JSON.stringify(q.options),q.points,q.resolutionRule,q.maxChoices]);
 return {created:true,id};
}
async function resolve(c,b) {
 const id=uuid(b.questionId);if(!['settled','void'].includes(b.status))fail(400,'Invalid resolution status');
 if(!Array.isArray(b.evidence)||!b.evidence.length||b.evidence.length>8)fail(400,'Evidence required');
 const evidence=b.evidence.map(e=>{let url;try{url=new URL(e.url)}catch{fail(400,'Invalid source URL')}if(url.protocol!=='https:'||url.username||url.password)fail(400,'HTTPS source required');return {url:clean(url.href,1500),summary:clean(e.summary,1000)}});
 const q=(await c.query('select q.*,r.round_key,r.closes_at<=clock_timestamp() as locked from jungle.questions q join jungle.rounds r on r.id=q.round_id where q.id=$1 for update of q',[id])).rows[0];
 if(!q)fail(404,'Question not found');if(!q.locked || (BELLA_EXTENSION_ROUNDS.has(q.round_key) && Date.now()<Date.parse(BELLA_EXTENSION_END)))fail(409,'Round still open');
 if(q.status!=='pending')fail(409,'Question already resolved');
 const answer=b.status==='settled'?normalChoice(b.answer,q,true):null;
 await c.query('update jungle.questions set status=$2,answer=$3,evidence=$4::jsonb,resolved_at=clock_timestamp() where id=$1',[id,b.status,answer,JSON.stringify(evidence)]);
 return {resolved:true,id};
}
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');
 if(!['GET','POST'].includes(req.method)){res.setHeader('Allow','GET, POST');return res.status(405).json({error:'Method not allowed'})}
 if(!process.env.DATABASE_URL)return res.status(503).json({mode:'setup',error:'Multiplayer database is not connected yet.'});
 let c,transaction=false;
 try{
  if(!pool)pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:5000,idleTimeoutMillis:10000});
  c=await pool.connect();
  if(req.method==='GET')return res.status(200).json(await state(c,req));
  const b=typeof req.body==='string'?JSON.parse(req.body):req.body;if(!b||typeof b!=='object'||Array.isArray(b))fail(400,'Invalid JSON');
  await c.query('begin');transaction=true;let out;
  switch(b.action){
   case 'join':out=await join(c,b);break;
   case 'issueRecovery':out=await issueRecovery(c,b,req);break;
   case 'recover':out=await recover(c,b);break;
   case 'predict':out=await submit(c,b,req);break;
   case 'publish':requireAdmin(req);out=await publish(c,b);break;
   case 'resolve':requireAdmin(req);out=await resolve(c,b);break;
   default:fail(400,'Unknown action');
  }
  await c.query('commit');transaction=false;return res.status(200).json(out);
 }catch(e){if(c&&transaction)await c.query('rollback').catch(()=>{});if(!e.status)console.error('Jungle API failed',e.code||e.name);return res.status(e.status||500).json({error:e.status?e.message:'Game service unavailable; please try again.'})}
 finally{if(c)c.release()}
};
