import {bountiesSso,sharedCsrfResponse,ssoDatabase,ssoEnabled,ssoJson} from "../../src/server/sharedSignIn.js";
import {nodeRequest,nodeResponse} from "../../shared/sso/client.mjs";
const origin="https://bounties.bittrees.org";
export default async function handler(req:any,res:any){
 const request=await nodeRequest(req,origin);
 if(new URL(request.url).pathname.endsWith("/csrf")){
  if(!ssoEnabled())return nodeResponse(ssoJson({error:"Unavailable"},503),res);
  try{return nodeResponse(await sharedCsrfResponse(request,ssoDatabase(),process.env.BITTREES_SSO_CLIENT_SECRET!),res);}catch{return nodeResponse(ssoJson({error:"Unavailable"},503),res);}
 }
 return nodeResponse(await bountiesSso(ssoDatabase())(request),res);
}
