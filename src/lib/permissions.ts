import type { Role } from "@/db/schema";

/**
 * Единый модуль прав и возможностей ролей в Nova CRM.
 *
 * Здесь сосредоточены все проверки доступа для UI, Server Actions и API-роутов:
 * управление командой, паролями, рабочими данными, ботами и доступом к ИИ.
 */

export type RoleCapabilities = {
  role: Role;
  label: string;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isCompany: boolean;
  unlimitedLimits: boolean;
  canManageTeam: boolean;
  canManageData: boolean;
  canResetPasswords: boolean;
  canConfigureBots: boolean;
  canChangeRoles: boolean;
  canDeleteUsers: boolean;
  canGrantAgentAccess: boolean;
  canViewAgentUsage: boolean;
};

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Главный админ",
  admin: "Администратор",
  developer: "Разработчик",
  manager: "Менеджер",
  consultant: "Консультант",
  user: "Сотрудник",
};

export const ALL_ROLES: Role[] = [
  "super_admin",
  "admin",
  "developer",
  "manager",
  "consultant",
  "user",
];

export const ROLE_CAPABILITIES: Record<Role, RoleCapabilities> = {
  super_admin: {
    role: "super_admin",
    label: ROLE_LABELS.super_admin,
    isSuperAdmin: true,
    isAdmin: true,
    isCompany: true,
    unlimitedLimits: true,
    canManageTeam: true,
    canManageData: true,
    canResetPasswords: true,
    canConfigureBots: true,
    canChangeRoles: true,
    canDeleteUsers: true,
    canGrantAgentAccess: true,
    canViewAgentUsage: true,
  },
  admin: {
    role: "admin",
    label: ROLE_LABELS.admin,
    isSuperAdmin: false,
    isAdmin: true,
    isCompany: true,
    unlimitedLimits: false,
    canManageTeam: true,
    canManageData: true,
    canResetPasswords: true,
    canConfigureBots: false,
    canChangeRoles: false,
    canDeleteUsers: false,
    canGrantAgentAccess: false,
    canViewAgentUsage: false,
  },
  developer: {
    role: "developer",
    label: ROLE_LABELS.developer,
    isSuperAdmin: false,
    isAdmin: false,
    isCompany: false,
    unlimitedLimits: false,
    canManageTeam: false,
    canManageData: false,
    canResetPasswords: false,
    canConfigureBots: false,
    canChangeRoles: false,
    canDeleteUsers: false,
    canGrantAgentAccess: false,
    canViewAgentUsage: false,
  },
  manager: {
    role: "manager",
    label: ROLE_LABELS.manager,
    isSuperAdmin: false,
    isAdmin: false,
    isCompany: true,
    unlimitedLimits: false,
    canManageTeam: true,
    canManageData: true,
    canResetPasswords: false,
    canConfigureBots: false,
    canChangeRoles: false,
    canDeleteUsers: false,
    canGrantAgentAccess: false,
    canViewAgentUsage: false,
  },
  consultant: {
    role: "consultant",
    label: ROLE_LABELS.consultant,
    isSuperAdmin: false,
    isAdmin: false,
    isCompany: false,
    unlimitedLimits: false,
    canManageTeam: false,
    canManageData: false,
    canResetPasswords: false,
    canConfigureBots: false,
    canChangeRoles: false,
    canDeleteUsers: false,
    canGrantAgentAccess: false,
    canViewAgentUsage: false,
  },
  user: {
    role: "user",
    label: ROLE_LABELS.user,
    isSuperAdmin: false,
    isAdmin: false,
    isCompany: false,
    unlimitedLimits: false,
    canManageTeam: false,
    canManageData: false,
    canResetPasswords: false,
    canConfigureBots: false,
    canChangeRoles: false,
    canDeleteUsers: false,
    canGrantAgentAccess: false,
    canViewAgentUsage: false,
  },
};

export function capabilitiesForRole(role: string | null | undefined): RoleCapabilities {
  if (role && Object.hasOwn(ROLE_CAPABILITIES, role)) {
    return ROLE_CAPABILITIES[role as Role];
  }
  return ROLE_CAPABILITIES.user;
}

export function isSuperAdminRole(role: string | null | undefined): boolean {
  return role === "super_admin";
}

export function isAdminRole(role: Role): boolean {
  return capabilitiesForRole(role).isAdmin;
}

export function isCompanyRole(role: Role): boolean {
  return capabilitiesForRole(role).isCompany;
}

export function canManageTeam(role: Role): boolean {
  return capabilitiesForRole(role).canManageTeam;
}

export function canManageData(role: Role): boolean {
  return capabilitiesForRole(role).canManageData;
}

export function canResetPasswords(role: Role): boolean {
  return capabilitiesForRole(role).canResetPasswords;
}

export function canConfigureBots(role: string | null | undefined): boolean {
  return capabilitiesForRole(role).canConfigureBots;
}

export function canManageRole(actor: Role, target: Role): boolean {
  if (actor === "super_admin") return true;
  if (actor === "admin" || actor === "manager") return target === "user" || target === "consultant";
  return false;
}

export function hasAgentAccess(
  user: { role?: string | null; canUseAgent?: boolean | null } | null | undefined,
): boolean {
  if (!user) return false;
  return user.role === "super_admin" || Boolean(user.canUseAgent);
}

export function hasOperatorAccess(
  user: { role?: string | null; canUseOperator?: boolean | null } | null | undefined,
): boolean {
  if (!user) return false;
  return user.role === "super_admin" || Boolean(user.canUseOperator);
}

export function canViewAgentUsage(user: { role?: string | null } | null | undefined): boolean {
  return capabilitiesForRole(user?.role).canViewAgentUsage;
}
