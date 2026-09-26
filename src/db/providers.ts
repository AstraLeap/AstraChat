import { randomUUID } from 'node:crypto';
import type { CreateProviderInput, Provider, UpdateProviderInput } from '../types/index';
import type { Db } from './connection';

/**
 * `providers` 表的数据访问层。
 *
 * 约定：所有写入都返回**写入后的完整实体**，方便 IPC 层直接把结果回传给渲染进程，
 * 不必让渲染层再查一次。
 */

/** SQLite 返回的 providers 行。 */
interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  created_at: number;
  updated_at: number;
}

/**
 * 把数据库行映射为领域对象（下划线命名 → 驼峰命名）。
 *
 * @param row SQLite 行。
 * @returns 领域对象。
 */
function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 规范化 Base URL：去掉末尾斜杠。
 *
 * 否则 `https://api.x.com/v1/` + `/chat/completions` 会拼出双斜杠。
 *
 * @param baseUrl 用户输入的地址。
 * @returns 去掉末尾斜杠的地址。
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * 列出全部提供商，按创建时间升序。
 *
 * @param db 数据库句柄。
 * @returns 提供商数组。
 */
export function listProviders(db: Db): Provider[] {
  const rows = db.raw
    .prepare('SELECT * FROM providers ORDER BY created_at ASC')
    .all() as ProviderRow[];
  return rows.map(toProvider);
}

/**
 * 按 id 查询单个提供商。
 *
 * @param db 数据库句柄。
 * @param id 提供商 id。
 * @returns 找到则返回实体，否则 `null`。
 */
export function getProvider(db: Db, id: string): Provider | null {
  const row = db.raw.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
    | ProviderRow
    | undefined;
  return row ? toProvider(row) : null;
}

/**
 * 新建提供商。
 *
 * @param db 数据库句柄。
 * @param input 名称 / Base URL / API Key / 默认模型。
 * @returns 新建的提供商。
 * @throws 当名称为空时抛出 `Error`。
 */
export function createProvider(db: Db, input: CreateProviderInput): Provider {
  const name = input.name.trim();
  if (!name) {
    throw new Error('提供商名称不能为空');
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) {
    throw new Error('Base URL 不能为空');
  }

  const now = Date.now();
  const provider: Provider = {
    id: randomUUID(),
    name,
    baseUrl,
    apiKey: input.apiKey.trim(),
    model: input.model.trim(),
    createdAt: now,
    updatedAt: now,
  };

  db.raw
    .prepare(
      `INSERT INTO providers (id, name, base_url, api_key, model, created_at, updated_at)
       VALUES (@id, @name, @baseUrl, @apiKey, @model, @createdAt, @updatedAt)`,
    )
    .run(provider);

  return provider;
}

/**
 * 更新提供商的部分字段。
 *
 * @param db 数据库句柄。
 * @param id 提供商 id。
 * @param patch 需要更新的字段。
 * @returns 更新后的提供商。
 * @throws 当 id 不存在时抛出 `Error`。
 */
export function updateProvider(db: Db, id: string, patch: UpdateProviderInput): Provider {
  const existing = getProvider(db, id);
  if (!existing) {
    throw new Error(`提供商不存在：${id}`);
  }

  const next: Provider = {
    ...existing,
    name: patch.name !== undefined ? patch.name.trim() : existing.name,
    baseUrl: patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : existing.baseUrl,
    apiKey: patch.apiKey !== undefined ? patch.apiKey.trim() : existing.apiKey,
    model: patch.model !== undefined ? patch.model.trim() : existing.model,
    updatedAt: Date.now(),
  };

  if (!next.name) {
    throw new Error('提供商名称不能为空');
  }
  if (!next.baseUrl) {
    throw new Error('Base URL 不能为空');
  }

  db.raw
    .prepare(
      `UPDATE providers
          SET name = @name, base_url = @baseUrl, api_key = @apiKey,
              model = @model, updated_at = @updatedAt
        WHERE id = @id`,
    )
    .run(next);

  return next;
}

/**
 * 删除提供商。
 *
 * 关联对话的 `provider_id` 会因外键 `ON DELETE SET NULL` 自动置空，对话本身保留。
 *
 * @param db 数据库句柄。
 * @param id 提供商 id。
 * @throws 当 id 不存在时抛出 `Error`。
 */
export function removeProvider(db: Db, id: string): void {
  const result = db.raw.prepare('DELETE FROM providers WHERE id = ?').run(id);
  if (result.changes === 0) {
    throw new Error(`提供商不存在：${id}`);
  }
}
