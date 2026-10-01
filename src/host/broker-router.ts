import { randomUUID } from 'node:crypto';
import { PilotError, type BrowserProfile } from '../shared.js';
import { toolDefinitions, type BrowserTool } from '../browser-api.js';
type Connection={profile:BrowserProfile;call:(command:string,payload?:unknown)=>Promise<any>};
type Session={id:string;profileId:string;name:string;owner:string};
export class BrokerRouter {
  private connections=new Map<string,Connection>();
  private sessions=new Map<string,Session>();
  register(connection:Connection){if(this.connections.has(connection.profile.id))throw new PilotError('profile_already_connected');this.connections.set(connection.profile.id,connection);}
  update(profile:BrowserProfile){
    const connection=this.connections.get(profile.id);if(!connection)throw new PilotError('profile_disconnected');connection.profile=profile;
    if(!profile.mcpEnabled)for(const s of [...this.sessions.values()])if(s.profileId===profile.id){this.sessions.delete(s.id);void connection.call('session.release',{sessionId:s.id}).catch(()=>{});}
  }
  disconnect(profileId:string){this.connections.delete(profileId);for(const s of this.sessions.values())if(s.profileId===profileId)this.sessions.delete(s.id);}
  async releaseOwner(owner:string){
    const sessions=[...this.sessions.values()].filter(s=>s.owner===owner);for(const s of sessions)this.sessions.delete(s.id);
    await Promise.allSettled(sessions.map(s=>this.connections.get(s.profileId)?.call('session.release',{sessionId:s.id})));
  }
  private connection(profileId:string){const c=this.connections.get(profileId);if(!c)throw new PilotError('profile_disconnected');if(!c.profile.mcpEnabled)throw new PilotError('mcp_access_disabled');return c;}
  async call(owner:string,tool:BrowserTool,input:unknown):Promise<any>{
    if(!Object.hasOwn(toolDefinitions,tool))throw new PilotError('unknown_tool');const p:any=toolDefinitions[tool].schema.parse(input);
    if(tool==='browser_profiles')return [...this.connections.values()].filter(c=>c.profile.mcpEnabled).map(c=>c.profile);
    if(tool==='browser_sessions')return [...this.sessions.values()].filter(s=>s.owner===owner).map(({owner,...s})=>s);
    if(tool==='browser_tabs')return this.connection(p.profileId).call('tabs.list');
    if(tool==='browser_vault_list')return this.connection(p.profileId).call('vault.list');
    if(tool==='browser_session_create'){
      if([...this.sessions.values()].filter(s=>s.owner===owner).length>=20)throw new PilotError('session_limit');
      const c=this.connection(p.profileId),id=randomUUID();this.sessions.set(id,{id,owner,profileId:p.profileId,name:p.name});
      try{
        const result=await c.call('session.create',{id,name:p.name,windowId:p.windowId});
        if(!this.sessions.has(id)||this.connections.get(p.profileId)!==c||!c.profile.mcpEnabled){await c.call('session.release',{sessionId:id}).catch(()=>{});throw new PilotError('session_closed');}
        return {...result,profileId:p.profileId};
      }catch(error){this.sessions.delete(id);throw error;}
    }
    const s=this.sessions.get(p.sessionId);if(!s||s.owner!==owner)throw new PilotError('session_not_owned');
    const c=this.connection(s.profileId),{sessionId,...payload}=p;
    if(tool==='browser_session_release'){this.sessions.delete(s.id);return c.call('session.release',{sessionId});}
    const commands:Partial<Record<BrowserTool,string>>={browser_session_attach:'pin',browser_session_open:'tabs.open',browser_observe:'observe',browser_decide:'decide',browser_prepare:'manual',browser_execute:'execute',browser_cancel:'cancel'};
    return c.call(commands[tool]!,{sessionId,...payload});
  }
}
