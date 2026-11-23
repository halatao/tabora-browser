import {z} from 'zod';
import {idSchema,secretScopeSchema} from './shared.js';

export const passwordBindingSchema=z.object({tabId:z.number().int().nonnegative(),documentId:z.string().min(1).max(100),origin:z.string().max(2048)}).strict();
export const passwordPrepareSchema=z.object({
  stateVersion:z.string().min(1).max(240),
  credentialId:idSchema.optional(),
  account:z.object({label:z.string().trim().min(1).max(100),username:z.string().min(1).max(500),scope:secretScopeSchema.optional()}).strict().optional(),
  length:z.number().int().min(16).max(128).default(24),symbols:z.boolean().default(true),
}).strict().refine(p=>!!p.credentialId!==!!p.account,'Supply an existing credential or a new account');
export const passwordFillSchema=z.object({
  changeId:idSchema,stateVersion:z.string().min(1).max(240),
  passwordTargetId:z.string().min(1).max(120),confirmationTargetId:z.string().min(1).max(120).optional(),currentPasswordTargetId:z.string().min(1).max(120).optional(),
}).strict().refine(p=>new Set([p.passwordTargetId,p.confirmationTargetId,p.currentPasswordTargetId].filter(Boolean)).size===[p.passwordTargetId,p.confirmationTargetId,p.currentPasswordTargetId].filter(Boolean).length,'Password fields must be distinct');
export const passwordResumeSchema=z.object({changeId:idSchema,stateVersion:z.string().min(1).max(240),refillAfterInspection:z.boolean().default(false)}).strict();
export const passwordResolveSchema=z.object({
  changeId:idSchema,stateVersion:z.string().min(1).max(240),outcome:z.enum(['confirmed','rejected','unknown']),
  confirmation:z.enum(['agent_verified','user_confirmed']).optional(),
}).strict().refine(p=>p.outcome!=='confirmed'||!!p.confirmation,'Confirmed changes require an explicit attestation');
export type PasswordBinding=z.infer<typeof passwordBindingSchema>;
