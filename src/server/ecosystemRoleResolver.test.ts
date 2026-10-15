import {describe,it,expect,vi} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {resolveSharedModerator,resolveSharedAuditAccess} from './sharedRoleResolver';
import {ecosystemDecisionMessage} from '../../shared/ecosystem-authority.mjs';
const source=generateKeyPairSync('ed25519'),issuer=generateKeyPairSync('ed25519');
const env={ROLES_ECOSYSTEM_REQUEST_PRIVATE_KEY:source.privateKey.export({type:'pkcs8',format:'pem'}).toString(),ROLES_ECOSYSTEM_DECISION_PUBLIC_KEY:issuer.publicKey.export({type:'spki',format:'pem'}).toString(),KV_REST_API_URL:'https://legacy.invalid',KV_REST_API_READ_ONLY_TOKEN:'legacy'};
const wallet='0x'+'1'.repeat(40);
function gateway(actions:string[],tampered=false){return vi.fn<typeof fetch>(async(url,init)=>{
 expect(String(url)).toBe('https://roles.bittrees.org/api/authority/ecosystem-decision');
 const {request}=JSON.parse(String(init?.body));const now=Date.now();
 const decision={version:1,issuer:'https://roles.bittrees.org',audience:request.source,request,enrolled:true,authoritative:true,actions,checkedAt:now,expiresAt:now+5000,requiresPrivateOwnership:true};
 return Response.json({decision,signature:tampered?'fake':sign(null,Buffer.from(ecosystemDecisionMessage(decision)),issuer.privateKey).toString('base64')});
});}
describe('Roles-backed Bounties permissions',()=>{
 it('partner audit access never becomes moderation authority',async()=>{
  const fetch=gateway(['tier.partner']);expect((await resolveSharedAuditAccess(wallet,{env,fetch})).status).toBe('authorized');expect((await resolveSharedModerator(wallet,{env,fetch})).status).toBe('not_authorized');expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('an enrolled denial and a forged response cannot restore legacy roles',async()=>{
  const fetch=gateway([]);expect((await resolveSharedAuditAccess(wallet,{env,fetch})).status).toBe('not_authorized');expect(fetch).toHaveBeenCalledTimes(1);
  const forged=gateway(['project.admin'],true);expect((await resolveSharedModerator(wallet,{env,fetch:forged})).status).toBe('unavailable');expect(forged).toHaveBeenCalledTimes(1);
 });
});
