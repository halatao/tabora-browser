import {PilotError,type BrowserProfile} from '../shared.js';

/** Closing completed work never includes attached user tabs or tabs moved out by the user. */
export function ownsCleanupTab(tab:{id?:number;windowId:number;groupId?:number},scope:{createdTabs:Set<number>;windowId?:number;groupId?:number},owner:string|undefined,sessionId:string){
  return tab.id!==undefined&&scope.createdTabs.has(tab.id)&&owner===sessionId&&scope.groupId!==undefined&&tab.groupId===scope.groupId&&tab.windowId===scope.windowId;
}

export function enforceRecipe(profile:Pick<BrowserProfile,'mode'|'vaultEnabled'>,recipe:string){
  if(profile.mode==='readonly'&&recipe!=='extract')throw new PilotError('readonly_mode');
  if(recipe==='login'&&!profile.vaultEnabled)throw new PilotError('vault_disabled');
}
export function enforceSafeTab(profile:Pick<BrowserProfile,'mode'>,tab:{id?:number;windowId:number;groupId?:number},scope:{createdTabs:Set<number>;safeWindowId?:number;groupId?:number}){
  if((profile.mode??'safe')!=='safe')return;
  if(tab.id===undefined||!scope.createdTabs.has(tab.id)||scope.safeWindowId!==tab.windowId||scope.groupId===undefined||tab.groupId!==scope.groupId)throw new PilotError('safe_mode_existing_tab');
}
