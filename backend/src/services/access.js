import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import { HttpError } from '../utils/http.js';

const RANK = { viewer: 1, member: 2, admin: 3, owner: 4 };

export const roleOf = (workspace, userId) =>
  workspace.members.find((m) => String(m.user?._id || m.user) === String(userId))?.role || null;

export const hasRole = (role, min) => (RANK[role] || 0) >= RANK[min];

/** Load a workspace and assert the user holds at least `min` role in it. */
export async function loadWorkspace(workspaceId, userId, min = 'viewer') {
  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) throw new HttpError(404, 'Workspace not found');
  const role = roleOf(workspace, userId);
  if (!role) throw new HttpError(403, 'You are not a member of this workspace');
  if (!hasRole(role, min)) throw new HttpError(403, `This action requires ${min} access`);
  return { workspace, role };
}

export async function myWorkspaceIds(userId) {
  const list = await Workspace.find({ 'members.user': userId }).select('_id');
  return list.map((w) => w._id);
}

/** Mongo filter matching every task the user may see. */
export async function visibleTaskFilter(userId) {
  const ids = await myWorkspaceIds(userId);
  // Explicit ObjectId so the filter also works inside aggregation pipelines (which do not cast).
  return { $or: [{ workspace: { $in: ids } }, { workspace: null, createdBy: new mongoose.Types.ObjectId(String(userId)) }] };
}
