// Tells connected desktop apps that something in a workspace changed, so they re-fetch it.
// In-process for now; with more than one server instance this becomes PostgreSQL LISTEN/NOTIFY.
import { EventEmitter } from 'node:events';

// `removed` names a person taken out of the workspace: their own stream gets it and is then closed.
export type ChangeKind = 'profiles' | 'proxies' | 'groups' | 'workspace' | 'members' | 'removed' | 'flows' | 'tasks' | 'runs';
export interface Change { kind: ChangeKind; ids?: string[]; userId?: string }

const bus = new EventEmitter();
bus.setMaxListeners(0);

export const publish = (workspaceId: string, change: Change) => { bus.emit(workspaceId, change); };

export function subscribe(workspaceId: string, fn: (c: Change) => void){
  bus.on(workspaceId, fn);
  return () => { bus.off(workspaceId, fn); };
}
