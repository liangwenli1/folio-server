// Tells connected desktop apps that something in a workspace changed, so they re-fetch it.
// In-process for now; with more than one server instance this becomes PostgreSQL LISTEN/NOTIFY.
import { EventEmitter } from 'node:events';

export type ChangeKind = 'profiles' | 'proxies' | 'groups' | 'workspace';
export interface Change { kind: ChangeKind; ids?: string[] }

const bus = new EventEmitter();
bus.setMaxListeners(0);

export const publish = (workspaceId: string, change: Change) => { bus.emit(workspaceId, change); };

export function subscribe(workspaceId: string, fn: (c: Change) => void){
  bus.on(workspaceId, fn);
  return () => { bus.off(workspaceId, fn); };
}
