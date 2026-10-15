export type EcosystemAccess={version:number;authoritative:boolean;enrolled:boolean;actions:string[];unavailableTiers?:string[];expiresAt:number;checkedAt:number;requiresPrivateOwnership:true};
export function ecosystemAccess(project:string,subjects:string[],options?:{env?:Record<string,string|undefined>;fetcher?:typeof fetch;authenticatedWallet?:string|null}):Promise<EcosystemAccess>;
export function ecosystemSubject(project:string,kind:string,value:string,secret?:string):string;
