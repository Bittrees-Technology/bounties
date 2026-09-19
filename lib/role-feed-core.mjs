import {createHash,createHmac,sign,timingSafeEqual} from 'node:crypto';
export function feedAuthorized(header,secret){if(!secret||secret.length<32||!header)return false;const a=Buffer.from(header),b=Buffer.from('Bearer '+secret);return a.length===b.length&&timingSafeEqual(a,b);}
/**
 * @param {string} host
 * @param {Array<{identity:string,kind?:string,label?:string,scope:string,restrictions?:{recordIds:string[]|null},permissions?:Array<{id:string,label?:string,effect?:string,status?:string,expiresAt?:string}>}>} rows
 * @param {{env?:Record<string,string|undefined>,coverageNote?:string,roledefs?:string[],now?:number}} options
 */
export function createRoleFeed(host,rows,{env=process.env,coverageNote,roledefs=[],now=Date.now()}={}){
 if(!env.ROLES_FEED_PRIVATE_KEY||!env.ROLES_FEED_SUBJECT_SECRET||env.ROLES_FEED_SUBJECT_SECRET.length<32)throw Error('Feed not configured');
 if(!Array.isArray(rows)||rows.length>1000)throw Error('Feed exceeds bounded roster');
 const subjects={},roles={},permissions={},permissiondefs=new Map(),catalog=new Set(roledefs);
 for(const row of rows){
  if(typeof row.identity!=='string'||!row.identity||row.identity.length>512||typeof row.scope!=='string'||!row.scope||row.scope.length>512)throw Error('Invalid source record');
  const kind=row.kind||(/^0x[0-9a-f]{40}$/i.test(row.identity)?'wallet':row.identity.includes('@')?'email':'account');
  if(!['wallet','email','account','service'].includes(kind))throw Error('Invalid subject type');
  if(kind==='wallet'&&!/^0x[0-9a-f]{40}$/i.test(row.identity))throw Error('Invalid wallet');
  const key=kind==='wallet'?row.identity.toLowerCase():'subject:'+createHmac('sha256',env.ROLES_FEED_SUBJECT_SECRET).update(JSON.stringify([host,kind,row.identity])).digest('hex');
  if(kind!=='wallet')subjects[key]={kind,label:host.split('.')[0]+' '+kind+' '+key.slice(8,16)};
  if(row.label){
   if(typeof row.label!=='string'||row.label.length>100)throw Error('Invalid role');
   const e={label:row.label,scope:row.scope,...(row.restrictions?{restrictions:row.restrictions}:{})};
   const entries=roles[key]||=[];if(!entries.some(v=>JSON.stringify(v)===JSON.stringify(e)))entries.push(e);catalog.add(row.label);
  }
  for(const p of row.permissions||[]){
   const entry={id:p.id,scope:row.scope,effect:p.effect||'allow',status:p.status||'active',expiresAt:p.expiresAt||null,policyVersion:null};
   const entries=permissions[key]||=[];if(!entries.some(v=>JSON.stringify(v)===JSON.stringify(entry)))entries.push(entry);
   permissiondefs.set(p.id,{id:p.id,label:p.label||p.id});
  }
 }
 const content={subjects,roles,roledefs:[...catalog].sort().map(label=>({label})),tags:null,tagdefs:null,permissions,permissiondefs:[...permissiondefs.values()].sort((a,b)=>a.id.localeCompare(b.id)),permissionCoverage:'partial',coverageNote};
 const data={schemaVersion:3,source:host,audience:'https://roles.bittrees.org',generatedAt:new Date(now).toISOString(),revision:createHash('sha256').update(JSON.stringify(content)).digest('hex'),...content};
 return {data,signature:sign(null,Buffer.from(JSON.stringify(data)),env.ROLES_FEED_PRIVATE_KEY).toString('base64')};
}
