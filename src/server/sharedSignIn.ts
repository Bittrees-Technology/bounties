import postgres from "postgres";
import {randomBytes} from "node:crypto";
import * as sharedRuntime from "../../shared/sso/client.mjs";
import {createSsoClient,digest,seal,cookie,readCookie} from "../../shared/sso/client.mjs";
import {requiredServerEnv} from "./serverEnv.js";
type SessionRow={wallet_address:string;created_at:string|Date;csrf_digest:string};
type SessionDatabase={unsafe:(sql:string,values?:(string|number)[])=>Promise<SessionRow[]>};
const origin="https://bounties.bittrees.org";
export const ssoJson=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"}});
const walletOnly=(value:string)=>{if(!/^0x[0-9a-f]{40}$/.test(value))throw Error("WALLET_REQUIRED");return value;};
let sql:ReturnType<typeof postgres>|undefined;
export function ssoDatabase(){return sql??=postgres(requiredServerEnv("POSTGRES_URL"),{max:2,connect_timeout:5,idle_timeout:20,prepare:false});}
export function bountiesSessionCookie(req:Request){return (req.headers.get("cookie")||"").split(";").map(v=>v.trim()).find(v=>v.startsWith("bounties_session="))?.slice(17)||"";}
export function csrfCookie(key:string,csrf:string,secret:string,age=1800){return cookie("bt-sso-bounties-csrf",seal({sessionHash:digest(key),csrf},secret),age,origin);}
export function ssoEnabled(){return process.env.BITTREES_SSO_ENABLED==="1"&&!!process.env.BITTREES_SSO_CLIENT_SECRET&&process.env.BITTREES_SSO_CLIENT_SECRET.length>=32;}
export function bountiesSsoAdapter(db:SessionDatabase,secret:string) {
 return {
  async current(req:Request){
   const key=bountiesSessionCookie(req);if(!/^[a-f0-9]{64}$/.test(key))return null;
   const [row]=await db.unsafe("SELECT a.wallet_address,s.created_at,s.csrf_digest FROM public.wallet_sessions s JOIN public.wallet_accounts a ON a.id=s.account_id WHERE s.token_digest=$1 AND s.revoked_at IS NULL AND s.idle_expires_at>now() AND s.absolute_expires_at>now()",[digest(key)]);
   return row?{key,identity:walletOnly(row.wallet_address),authTime:new Date(row.created_at).getTime(),csrfDigest:row.csrf_digest}:null;
  },
  async establish(identity:string,authTime:number){
   const wallet=walletOnly(identity),key=randomBytes(32).toString("hex"),csrf=randomBytes(32).toString("hex");
   const expires=Math.min(Date.now()+86400000,authTime+604800000);if(expires<=Date.now())throw Error("SIGN_IN_REQUIRED");
   // One statement creates only an ordinary account and native session. No role or escrow writes.
   await db.unsafe("WITH account AS (INSERT INTO public.wallet_accounts(wallet_address) VALUES($1) ON CONFLICT(wallet_address) DO UPDATE SET last_seen_at=now() RETURNING id) INSERT INTO public.wallet_sessions(account_id,token_digest,csrf_digest,idle_expires_at,absolute_expires_at) SELECT id,$2,$3,least(now()+interval '30 minutes',to_timestamp($4)),least(now()+interval '24 hours',to_timestamp($4)) FROM account",[wallet,digest(key),digest(csrf),expires/1000]);
   return {key,cookies:[`bounties_session=${key}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`,csrfCookie(key,csrf,secret)]};
  }
 };
}
export function bountiesSso(db:SessionDatabase,config=process.env,fetcher=fetch){return createSsoClient({clientId:"bounties",cookiePrefix:"bt-sso-bounties",origin,issuer:config.BITTREES_SSO_ISSUER||"https://roles.bittrees.org",secret:config.BITTREES_SSO_CLIENT_SECRET,enabled:config.BITTREES_SSO_ENABLED==="1",fetcher,adapter:bountiesSsoAdapter(db,config.BITTREES_SSO_CLIENT_SECRET||"")});}
// Capture native CSRF only inside a sealed HttpOnly cookie, bound to that session.
export async function retainNativeCsrf(response:Response){
 if(!ssoEnabled()||!response.ok)return response;
 const d=await response.clone().json().catch(()=>null);if(!d?.csrfToken||!/^[a-f0-9]{64}$/.test(d.csrfToken))return response;
 const key=response.headers.getSetCookie().map(v=>/^bounties_session=([a-f0-9]{64});/.exec(v)?.[1]).find(Boolean);
 if(key)response.headers.append("Set-Cookie",csrfCookie(key,d.csrfToken,process.env.BITTREES_SSO_CLIENT_SECRET!));return response;
}
export function suppressSharedResume(response:Response){if(ssoEnabled()){response.headers.append("Set-Cookie",cookie("bt-sso-bounties-skip","1",604800,origin));response.headers.append("Set-Cookie",cookie("bt-sso-bounties-published","",0,origin));response.headers.append("Set-Cookie",cookie("bt-sso-bounties-csrf","",0,origin));}return response;}

export async function sharedCsrfResponse(request:Request,db:SessionDatabase,secret:string):Promise<Response>{
 if(request.method!=="GET"||new URL(request.url).origin!==origin||(request.headers.get("origin")&&request.headers.get("origin")!==origin)||["cross-site","same-site"].includes(request.headers.get("sec-fetch-site")||""))return ssoJson({error:"Rejected"},403);
 const session=await bountiesSsoAdapter(db,secret).current(request);
 const unseal=(sharedRuntime as typeof sharedRuntime & {unseal:(value:string,secret:string)=>unknown}).unseal;
 const proof=unseal(readCookie(request,"bt-sso-bounties-csrf",origin),secret);
 if(!session||!proof||typeof proof!=="object"||!("sessionHash" in proof)||!("csrf" in proof)||proof.sessionHash!==digest(session.key)||typeof proof.csrf!=="string"||!/^[a-f0-9]{64}$/.test(proof.csrf)||digest(proof.csrf)!==session.csrfDigest)return ssoJson({error:"Sign in first"},401);
 return ssoJson({csrfToken:proof.csrf});
}
