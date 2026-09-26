import { randomUUID } from 'node:crypto';
import type { CreatePersonaInput, Persona, UpdatePersonaInput } from '../types/index';
import { fromBool, toBool, type Db } from './connection';

/**
 * `personas` 表的数据访问层（角色 / 提示词管理）。
 */

/** SQLite 返回的 personas 行。 */
interface PersonaRow {
  id: string;
  name: string;
  avatar: string | null;
  system_prompt: string;
  is_preset: number;
  created_at: number;
  updated_at: number;
}

/**
 * 把数据库行映射为领域对象。
 *
 * @param row SQLite 行。
 * @returns 角色领域对象。
 */
function toPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    systemPrompt: row.system_prompt,
    isPreset: toBool(row.is_preset),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 列出全部角色：内置示例角色在前，其余按创建时间升序。
 *
 * @param db 数据库句柄。
 * @returns 角色数组。
 */
export function listPersonas(db: Db): Persona[] {
  const rows = db.raw
    .prepare('SELECT * FROM personas ORDER BY is_preset DESC, created_at ASC')
    .all() as PersonaRow[];
  return rows.map(toPersona);
}

/**
 * 按 id 查询角色。
 *
 * @param db 数据库句柄。
 * @param id 角色 id。
 * @returns 找到则返回，否则 `null`。
 */
export function getPersona(db: Db, id: string): Persona | null {
  const row = db.raw.prepare('SELECT * FROM personas WHERE id = ?').get(id) as
    | PersonaRow
    | undefined;
  return row ? toPersona(row) : null;
}

/**
 * 新建角色。
 *
 * @param db 数据库句柄。
 * @param input 名称 / 头像 / 系统提示词。
 * @returns 新建的角色。
 * @throws 当名称为空时抛出 `Error`。
 */
export function createPersona(db: Db, input: CreatePersonaInput): Persona {
  const name = input.name.trim();
  if (!name) {
    throw new Error('角色名称不能为空');
  }

  const now = Date.now();
  const persona: Persona = {
    id: randomUUID(),
    name,
    avatar: input.avatar ?? null,
    systemPrompt: input.systemPrompt ?? '',
    isPreset: input.isPreset ?? false,
    createdAt: now,
    updatedAt: now,
  };

  db.raw
    .prepare(
      `INSERT INTO personas (id, name, avatar, system_prompt, is_preset, created_at, updated_at)
       VALUES (@id, @name, @avatar, @systemPrompt, @isPreset, @createdAt, @updatedAt)`,
    )
    .run({ ...persona, isPreset: fromBool(persona.isPreset) });

  return persona;
}

/**
 * 更新角色的部分字段。
 *
 * @param db 数据库句柄。
 * @param id 角色 id。
 * @param patch 需要更新的字段。
 * @returns 更新后的角色。
 * @throws 当 id 不存在时抛出 `Error`。
 */
export function updatePersona(db: Db, id: string, patch: UpdatePersonaInput): Persona {
  const existing = getPersona(db, id);
  if (!existing) {
    throw new Error(`角色不存在：${id}`);
  }

  const next: Persona = {
    ...existing,
    name: patch.name !== undefined ? patch.name.trim() : existing.name,
    avatar: patch.avatar !== undefined ? patch.avatar : existing.avatar,
    systemPrompt: patch.systemPrompt !== undefined ? patch.systemPrompt : existing.systemPrompt,
    isPreset: patch.isPreset !== undefined ? patch.isPreset : existing.isPreset,
    updatedAt: Date.now(),
  };

  if (!next.name) {
    throw new Error('角色名称不能为空');
  }

  db.raw
    .prepare(
      `UPDATE personas
          SET name = @name, avatar = @avatar, system_prompt = @systemPrompt,
              is_preset = @isPreset, updated_at = @updatedAt
        WHERE id = @id`,
    )
    .run({ ...next, isPreset: fromBool(next.isPreset) });

  return next;
}

/**
 * 删除角色。
 *
 * 绑定该角色的对话其 `persona_id` 由外键 `ON DELETE SET NULL` 置空。
 *
 * @param db 数据库句柄。
 * @param id 角色 id。
 * @throws 当 id 不存在时抛出 `Error`。
 */
export function removePersona(db: Db, id: string): void {
  const result = db.raw.prepare('DELETE FROM personas WHERE id = ?').run(id);
  if (result.changes === 0) {
    throw new Error(`角色不存在：${id}`);
  }
}
