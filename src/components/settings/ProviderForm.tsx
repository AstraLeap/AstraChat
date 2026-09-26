import { useEffect, useState } from 'react';
import { PROVIDER_PRESETS } from '../../services/presets';
import {
  EMPTY_PROVIDER_FORM,
  toProviderInput,
  useProviderStore,
  validateProviderForm,
  type ProviderFormErrors,
  type ProviderFormValues,
} from '../../stores/useProviderStore';
import type { Provider } from '../../types/index';
import { Button, Field, Input, Modal, Select } from '../ui';

/**
 * 提供商的「新建 / 编辑」表单。
 *
 * 校验分两层：提交前用 {@link validateProviderForm} 做字段级校验并写入 `Field` 的 `error`
 * （用户在对应输入框下方立刻看到原因），store 动作内再兜底校验一次。
 */

/** `ProviderForm` 组件属性。 */
export interface ProviderFormProps {
  /** 是否显示。 */
  open: boolean;
  /** 待编辑的提供商；`null` 表示新建。 */
  provider: Provider | null;
  /** 关闭回调（取消 / 保存成功 / Esc / 点击遮罩）。 */
  onClose: () => void;
}

/** 「从预设填充」下拉里代表「不填充」的哨兵值。 */
const NO_PRESET = '';

/**
 * 把提供商实体转成表单值。
 *
 * @param provider 提供商；`null` 时返回空表单。
 * @returns 表单值。
 */
function toFormValues(provider: Provider | null): ProviderFormValues {
  if (!provider) {
    return { ...EMPTY_PROVIDER_FORM };
  }
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
  };
}

/**
 * 提供商新建 / 编辑表单。
 *
 * @param props 见 {@link ProviderFormProps}。
 * @returns 模态框。
 */
export default function ProviderForm({ open, provider, onClose }: ProviderFormProps) {
  const saving = useProviderStore((state) => state.saving);
  const storeError = useProviderStore((state) => state.error);
  const createProvider = useProviderStore((state) => state.create);
  const updateProvider = useProviderStore((state) => state.update);
  const clearError = useProviderStore((state) => state.clearError);

  const [values, setValues] = useState<ProviderFormValues>(() => toFormValues(provider));
  const [errors, setErrors] = useState<ProviderFormErrors>({});
  const [presetKey, setPresetKey] = useState<string>(NO_PRESET);
  const [showApiKey, setShowApiKey] = useState(false);

  // 每次打开时同步数据源，避免上一次编辑的残留值串到下一个提供商。
  useEffect(() => {
    if (open) {
      setValues(toFormValues(provider));
      setErrors({});
      setPresetKey(NO_PRESET);
      setShowApiKey(false);
      clearError();
    }
  }, [open, provider, clearError]);

  /**
   * 更新单个字段并清掉该字段的旧错误，让用户改完立刻看到红字消失。
   *
   * @param key 字段名。
   * @param value 新值。
   * @returns 无。
   */
  function setField<K extends keyof ProviderFormValues>(key: K, value: ProviderFormValues[K]): void {
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
   * 选择预设后一键填充名称 / 地址 / 模型；`custom` 预设有意留空地址与模型。
   *
   * API Key 一律不填 —— 预设里不存在任何密钥，必须由用户自己粘贴。
   *
   * @param key 预设标识。
   * @returns 无。
   */
  function applyPreset(key: string): void {
    setPresetKey(key);
    const preset = PROVIDER_PRESETS.find((item) => item.key === key);
    if (!preset) {
      return;
    }
    setValues((previous) => ({
      ...previous,
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
    }));
    setErrors((previous) => {
      const next = { ...previous };
      delete next.name;
      delete next.baseUrl;
      return next;
    });
  }

  /**
   * 提交表单：先本地校验，再按「新建 / 更新」调用 store。
   *
   * @returns 无。
   */
  async function handleSubmit(): Promise<void> {
    const nextErrors = validateProviderForm(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    const input = toProviderInput(values);
    const saved = provider
      ? await updateProvider(provider.id, input)
      : await createProvider(input);

    if (saved) {
      onClose();
    }
  }

  const selectedPreset = PROVIDER_PRESETS.find((item) => item.key === presetKey) ?? null;

  return (
    <Modal
      open={open}
      title={provider ? `编辑提供商 · ${provider.name}` : '新建提供商'}
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
        <Field
          label="从预设填充"
          htmlFor="provider-preset"
          hint={
            selectedPreset?.docsUrl ? (
              <>
                预设只填名称 / 地址 / 模型，不包含任何密钥。申请地址：
                <a
                  className="text-[var(--astra-accent)] underline underline-offset-2"
                  href={selectedPreset.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {selectedPreset.docsUrl}
                </a>
              </>
            ) : (
              '可选：选中后自动填入名称、接口地址与默认模型，可继续手工修改。'
            )
          }
        >
          <Select
            id="provider-preset"
            value={presetKey}
            onChange={(event) => applyPreset(event.target.value)}
          >
            <option value={NO_PRESET}>— 不填充，手动填写 —</option>
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.key} value={preset.key}>
                {preset.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="名称" htmlFor="provider-name" required error={errors.name}>
          <Input
            id="provider-name"
            value={values.name}
            invalid={Boolean(errors.name)}
            placeholder="例如：DeepSeek 官方"
            onChange={(event) => setField('name', event.target.value)}
          />
        </Field>

        <Field
          label="接口地址（Base URL）"
          htmlFor="provider-base-url"
          required
          error={errors.baseUrl}
          hint="不含 /chat/completions，实际请求路径为「Base URL + /chat/completions」。"
        >
          <Input
            id="provider-base-url"
            value={values.baseUrl}
            invalid={Boolean(errors.baseUrl)}
            placeholder="https://api.deepseek.com/v1"
            spellCheck={false}
            onChange={(event) => setField('baseUrl', event.target.value)}
          />
        </Field>

        <Field
          label="API Key"
          htmlFor="provider-api-key"
          required
          error={errors.apiKey}
          hint="明文保存在本机 SQLite（v0.1.0 不做加密），仅用于向该提供商发起请求。"
        >
          <div className="flex items-center gap-2">
            <Input
              id="provider-api-key"
              type={showApiKey ? 'text' : 'password'}
              value={values.apiKey}
              invalid={Boolean(errors.apiKey)}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setField('apiKey', event.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              aria-pressed={showApiKey}
              onClick={() => setShowApiKey((previous) => !previous)}
            >
              {showApiKey ? '隐藏' : '显示'}
            </Button>
          </div>
        </Field>

        <Field
          label="默认模型名"
          htmlFor="provider-model"
          hint="留空则由服务端默认模型接管；每个对话还可以单独覆盖。"
        >
          <Input
            id="provider-model"
            value={values.model}
            placeholder="deepseek-chat"
            spellCheck={false}
            onChange={(event) => setField('model', event.target.value)}
          />
        </Field>

        {storeError ? (
          <p
            role="alert"
            className="rounded-md border border-[var(--astra-danger)]/40 bg-[var(--astra-danger)]/10 px-3 py-2 text-xs text-[var(--astra-danger)]"
          >
            {storeError}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
