import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  EMPTY_PERSONA_FORM,
  toPersonaInput,
  usePersonaStore,
  validatePersonaForm,
  type PersonaFormErrors,
  type PersonaFormValues,
} from '../../stores/usePersonaStore';
import type { Persona } from '../../types/index';
import { Button, Field, Input, Modal, Textarea } from '../ui';

/**
 * 角色的「新建 / 编辑」表单。
 *
 * 头像的取图方式：渲染进程处于 `sandbox: true` 且没有 Node 权限，无法读取磁盘路径，
 * 因此走 `<input type="file">` + `FileReader.readAsDataURL()`，把图片读成 data URL 存库。
 */

/** `PersonaForm` 组件属性。 */
export interface PersonaFormProps {
  /** 是否显示。 */
  open: boolean;
  /** 待编辑的角色；`null` 表示新建。 */
  persona: Persona | null;
  /** 关闭回调。 */
  onClose: () => void;
}

/**
 * 头像 data URL 的体积上限（字节）。
 *
 * SQLite 存 data URL 会让数据库迅速膨胀，且每轮请求都要把它读进内存，1 MB 足够一张
 * 头像用；超出则明确报错而不是默默塞进去。
 */
const MAX_AVATAR_BYTES = 1024 * 1024;

/**
 * 把角色实体转成表单值。
 *
 * @param persona 角色；`null` 时返回空表单。
 * @returns 表单值。
 */
function toFormValues(persona: Persona | null): PersonaFormValues {
  if (!persona) {
    return { ...EMPTY_PERSONA_FORM };
  }
  return {
    name: persona.name,
    avatar: persona.avatar,
    systemPrompt: persona.systemPrompt,
  };
}

/**
 * 角色新建 / 编辑表单。
 *
 * @param props 见 {@link PersonaFormProps}。
 * @returns 模态框。
 */
export default function PersonaForm({ open, persona, onClose }: PersonaFormProps) {
  const saving = usePersonaStore((state) => state.saving);
  const storeError = usePersonaStore((state) => state.error);
  const createPersona = usePersonaStore((state) => state.create);
  const updatePersona = usePersonaStore((state) => state.update);
  const clearError = usePersonaStore((state) => state.clearError);

  const [values, setValues] = useState<PersonaFormValues>(() => toFormValues(persona));
  const [errors, setErrors] = useState<PersonaFormErrors>({});
  /** 头像读取的本地错误（体积超限 / 读取失败），与字段校验错误分开管理。 */
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValues(toFormValues(persona));
      setErrors({});
      setAvatarError(null);
    }
  }, [open, persona]);

  /**
   * 更新单个字段并清掉该字段的旧错误。
   *
   * @param key 字段名。
   * @param value 新值。
   * @returns 无。
   */
  function setField<K extends keyof PersonaFormValues>(key: K, value: PersonaFormValues[K]): void {
    setValues((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      if (!previous[key]) {
        return previous;
      }
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  /**
   * 处理头像选择：读取为 data URL。
   *
   * @param event 文件输入事件。
   * @returns 无。
   */
  function handleAvatarChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // 允许重复选择同一个文件（否则第二次 change 不触发）。
    event.target.value = '';
    if (!file) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      setAvatarError('请选择图片文件（PNG / JPEG / WebP / GIF）');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarError(`图片不能超过 ${Math.round(MAX_AVATAR_BYTES / 1024)} KB，当前 ${Math.round(file.size / 1024)} KB`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        setValues((previous) => ({ ...previous, avatar: result }));
        setAvatarError(null);
      } else {
        setAvatarError('图片读取失败，请重试');
      }
    };
    reader.onerror = () => setAvatarError('图片读取失败，请重试');
    reader.readAsDataURL(file);
  }

  /**
   * 提交表单。
   *
   * @returns 无。
   */
  async function handleSubmit(): Promise<void> {
    const nextErrors = validatePersonaForm(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    const input = toPersonaInput(values);
    const saved = persona ? await updatePersona(persona.id, input) : await createPersona(input);
    if (saved) {
      onClose();
    }
  }

  const avatarPreview = values.avatar?.trim() ? values.avatar : null;
  const displayError = avatarError ?? storeError;

  return (
    <Modal
      open={open}
      title={persona ? `编辑角色 · ${persona.name}` : '新建角色'}
      onClose={onClose}
      widthClassName="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void handleSubmit()}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {persona?.isPreset ? (
          <p className="rounded-md border border-[var(--astra-accent)]/30 bg-[var(--astra-accent-soft)] px-3 py-2 text-[11px] text-[var(--astra-text)]">
            这是内置示例角色，可以自由编辑；改动只影响你自己的本机配置。
          </p>
        ) : null}

        <Field label="头像" error={errors.avatar} hint="可选。留空则用名称首字母作为占位。">
          <div className="flex items-center gap-3">
            {avatarPreview ? (
              <img
                src={avatarPreview}
                alt="头像预览"
                className="size-12 shrink-0 rounded-full border border-[var(--astra-border)] object-cover"
              />
            ) : (
              <div className="flex size-12 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--astra-border)] text-xs text-[var(--astra-muted)]">
                {values.name.trim().slice(0, 1) || '?'}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
                选择图片
              </Button>
              {avatarPreview ? (
                <Button size="sm" variant="ghost" onClick={() => setField('avatar', null)}>
                  移除
                </Button>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>
          </div>
        </Field>

        <Field label="角色名称" htmlFor="persona-name" required error={errors.name}>
          <Input
            id="persona-name"
            value={values.name}
            invalid={Boolean(errors.name)}
            placeholder="例如：代码搭档"
            onChange={(event) => setField('name', event.target.value)}
          />
        </Field>

        <Field
          label="系统提示词"
          htmlFor="persona-prompt"
          hint="会在每次请求时作为首条 system 消息注入。写清职责、语气与输出约定效果最好。"
        >
          <Textarea
            id="persona-prompt"
            rows={10}
            value={values.systemPrompt}
            placeholder="你是一名严谨的资深工程师，回答时先给结论……"
            onChange={(event) => setField('systemPrompt', event.target.value)}
          />
        </Field>

        {displayError ? (
          <p
            role="alert"
            className="rounded-md border border-[var(--astra-danger)]/40 bg-[var(--astra-danger)]/10 px-3 py-2 text-xs text-[var(--astra-danger)]"
          >
            {displayError}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
