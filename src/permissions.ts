// What a role may do. A role is a set of these; a workspace's groups decide which profiles it applies to.
// The list is the one the workbench's Roles page shows, in its order.
export const PERMISSIONS = [
  'profiles.view', 'profiles.create', 'profiles.edit', 'profiles.open', 'profiles.delete',
  'cookies.import', 'cookies.export', 'profiles.export',
  'proxies.view', 'proxies.bind', 'proxies.edit',
  'team.manage', 'activity.view'
] as const;
export type Permission = typeof PERMISSIONS[number];

// Administering the workspace itself — members, roles, groups, settings, the extension library, the subscription —
// goes with being able to manage members. There is no separate toggle for it.
export const MANAGE: Permission = 'team.manage';

export type BuiltInRole = 'owner' | 'admin' | 'member' | 'viewer';
export const BUILT_IN_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

// `name` is a fallback for anything that reads the stored name; the apps show their own wording for a role with a
// key. The owner's set is the whole list and is never edited.
export const BUILT_IN: Record<BuiltInRole, { name: string; permissions: Permission[] }> = {
  owner: { name: 'Owner', permissions: [...PERMISSIONS] },
  admin: { name: 'Admin', permissions: [...PERMISSIONS] },
  member: {
    name: 'Member',
    permissions: ['profiles.view', 'profiles.create', 'profiles.edit', 'profiles.open', 'cookies.import', 'proxies.view', 'proxies.bind']
  },
  viewer: { name: 'Viewer', permissions: ['profiles.view', 'proxies.view'] }
};
