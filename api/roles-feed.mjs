import postgres from 'postgres';
import {feedAuthorized,createRoleFeed} from '../lib/role-feed-core.mjs';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 if(!feedAuthorized(req.headers.authorization,process.env.ROLES_FEED_READ_TOKEN))return res.status(401).json({error:'Feed authentication required'});
 let sql;
 try{
  const url=process.env.POSTGRES_URL_NON_POOLING||process.env.POSTGRES_URL;if(!url)throw Error('Storage unavailable');
  sql=postgres(url,{max:1,prepare:false,connect_timeout:10});
  const records=await sql`SELECT a.wallet_address, r.role, 'marketplace' AS scope FROM public.account_roles r JOIN public.wallet_accounts a ON a.id=r.account_id UNION ALL SELECT a.wallet_address, s.role, 'moderation' AS scope FROM public.moderation_staff s JOIN public.wallet_accounts a ON a.id=s.account_id LIMIT 1001`;
  const rows=records.map(r=>({identity:r.wallet_address,kind:'wallet',label:r.role,scope:r.scope}));
  return res.status(200).json(createRoleFeed('bounties.bittrees.org',rows,{roledefs:['buyer','provider','moderator','admin'],coverageNote:'Explicit marketplace account roles and moderation staff. Short-lived shared Gov decisions, bounty-specific rights and linked identities are not inferred.'}));
 }catch{return res.status(503).json({error:'Role feed unavailable'});}
 finally{if(sql)await sql.end({timeout:2});}
}
