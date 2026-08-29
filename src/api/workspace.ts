interface WorkspaceApiData {
  error?: string;
  workspace?: Workspace;
  members?: Member[];
  invitations?: Invitation[];
  invitation?: Invitation;
  pendingInvitations?: Invitation[];
  ok?: boolean;
  email_sent?: boolean;
  email_error?: string;
}

async function apiFetch(url: string, opts?: RequestInit): Promise<{ ok: false; error: string } | { ok: true; data: WorkspaceApiData }> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { "Content-Type": "application/json", ...opts?.headers },
      credentials: "include",
    });
  } catch {
    return { ok: false, error: "Network error" };
  }
  let data: WorkspaceApiData;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Invalid server response" };
  }
  if (!res.ok) return { ok: false, error: data.error || "Request failed" };
  return { ok: true, data };
}

export type Workspace = {
  id: string;
  name: string;
  ownerId: string;
  type: string;
};

export type Member = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  joinedAt: string;
};

export type Invitation = {
  id: string;
  email: string;
  role: string;
  status: string;
  sentAt: string;
  invitedBy?: string;
  expiresAt?: string;
  emailSent?: boolean;
};

export type InviteInfo = {
  workspaceName: string;
  inviterName: string;
  role: string;
  expiresAt: string | null;
  email: string;
};

export async function getInviteInfo(token: string): Promise<{ invitation?: InviteInfo; error?: string }> {
  let res: Response;
  try {
    res = await fetch(`/api/invite/${encodeURIComponent(token)}`);
  } catch {
    return { error: "Network error" };
  }
  let data: { invitation?: InviteInfo; error?: string };
  try {
    data = await res.json();
  } catch {
    return { error: "Invalid server response" };
  }
  if (!res.ok) return { error: data.error || "Request failed" };
  return { invitation: data.invitation };
}

export async function acceptInvite(token: string): Promise<{ workspace_id?: string; role?: string; error?: string }> {
  let res: Response;
  try {
    res = await fetch(`/api/invite/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
  } catch {
    return { error: "Network error" };
  }
  let data: { workspace_id?: string; role?: string; error?: string };
  try {
    data = await res.json();
  } catch {
    return { error: "Invalid server response" };
  }
  if (!res.ok) return { error: data.error || "Request failed" };
  return data;
}

export async function getWorkspace(workspaceId?: string): Promise<{ workspace?: Workspace; error?: string }> {
  const qs = workspaceId ? `?workspace_id=${workspaceId}` : "";
  const res = await apiFetch(`/api/workspace${qs}`);
  if (!res.ok) return { error: res.error };
  return { workspace: res.data.workspace };
}

export async function updateWorkspace(name: string, workspaceId?: string): Promise<{ workspace?: Workspace; error?: string }> {
  const res = await apiFetch("/api/workspace", {
    method: "PATCH",
    body: JSON.stringify({ name, workspace_id: workspaceId }),
  });
  if (!res.ok) return { error: res.error };
  return { workspace: res.data.workspace };
}

export async function getMembers(workspaceId?: string): Promise<{ members: Member[]; pendingInvitations: Invitation[] }> {
  const qs = workspaceId ? `?workspace_id=${workspaceId}` : "";
  const res = await apiFetch(`/api/workspace/members${qs}`);
  if (!res.ok) return { members: [], pendingInvitations: [] };
  return { members: res.data.members ?? [], pendingInvitations: res.data.pendingInvitations ?? [] };
}

export async function changeRole(memberId: string, role: string, workspaceId: string): Promise<{ error?: string }> {
  const res = await apiFetch(`/api/workspace/members/${memberId}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role, workspace_id: workspaceId }),
  });
  if (!res.ok) return { error: res.error };
  return {};
}

export async function removeMember(memberId: string, workspaceId: string): Promise<{ error?: string }> {
  const res = await apiFetch(`/api/workspace/members/${memberId}?workspace_id=${workspaceId}`, {
    method: "DELETE",
  });
  if (!res.ok) return { error: res.error };
  return {};
}

export async function getInvitations(workspaceId?: string): Promise<{ invitations: Invitation[] }> {
  const qs = workspaceId ? `?workspace_id=${workspaceId}` : "";
  const res = await apiFetch(`/api/workspace/invitations${qs}`);
  if (!res.ok) return { invitations: [] };
  return { invitations: res.data.invitations ?? [] };
}

export async function sendInvitation(email: string, role: string = "member", workspaceId?: string): Promise<{ invitation?: Invitation; emailSent?: boolean; emailError?: string; error?: string }> {
  const res = await apiFetch("/api/workspace/invitations", {
    method: "POST",
    body: JSON.stringify({ email, role, workspace_id: workspaceId }),
  });
  if (!res.ok) return { error: res.error };
  return { invitation: res.data.invitation, emailSent: res.data.email_sent, emailError: res.data.email_error };
}

export async function resendInvitation(id: string, workspaceId?: string): Promise<{ emailSent?: boolean; emailError?: string; error?: string }> {
  const res = await apiFetch(`/api/workspace/invitations/${id}/resend`, {
    method: "POST",
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
  if (!res.ok) return { error: res.error };
  return { emailSent: res.data.email_sent, emailError: res.data.email_error };
}

export async function revokeInvitation(id: string, workspaceId?: string): Promise<{ error?: string }> {
  const qs = workspaceId ? `?workspace_id=${workspaceId}` : "";
  const res = await apiFetch(`/api/workspace/invitations/${id}${qs}`, { method: "DELETE" });
  if (!res.ok) return { error: res.error };
  return {};
}

export async function deleteWorkspace(workspaceId: string): Promise<{ error?: string }> {
  const res = await apiFetch(`/api/workspaces/${workspaceId}`, { method: "DELETE" });
  if (!res.ok) return { error: res.error };
  return {};
}
